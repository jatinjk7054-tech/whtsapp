import { v4 as uuidv4 } from 'uuid';
import { insertNewDataBatch, getImportBatches, getBatchRecords, getBatchCount, getBatchById, updateNewDataStatus, getExistingMobilesForNgo } from '../models/newDataModel.js';
import { upsertDonorProfilesBatch } from '../models/donorProfileModel.js';
import db from '../config/db.js';
import {
  parseImportFile,
  getSheetNames,
  dedupRows,
  normalizeDate,
} from '../services/fileParser.js';
import { autoAssignDonorsToStations, roundRobinAssignToStations } from '../services/assignmentHelpers.js';
// CJS cache wrapper; imported (not require()'d) because this module is ESM.
import redis from '../config/redis.cjs';

const yieldNow = () => new Promise((r) => setImmediate(r));
const CHUNK = 500;

const resolveAmount = (val) => {
  const parsed = parseFloat(val);
  if (parsed && parsed > 0) return parsed;
  return 200 + Math.floor(Math.random() * 19801);
};

export const inspectImport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }
    const sheets = getSheetNames(req.file.buffer);
    return res.json({ sheets });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadImport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }
    const { date, data_source_id, sheets, ngo_ids } = req.body;
    const bodyDataCategory = req.body.data_category || null;
    if (!date || !data_source_id) {
      return res.status(400).json({ message: 'Date and data source are required' });
    }

    const sheetFilter = sheets ? (Array.isArray(sheets) ? sheets : sheets.split(',').map(s => s.trim())) : undefined;
    const { rows: extracted, fullSheet } = parseImportFile(req.file.buffer, { sheets: sheetFilter });
    if (extracted.length === 0) {
      return res.status(400).json({ message: 'File is empty or has no data rows' });
    }

    if (fullSheet) {
      for (const r of extracted) {
        r.transaction_date = normalizeDate(r.transaction_date);
        r.birth_date = normalizeDate(r.birth_date);
        r.receipt_date = normalizeDate(r.receipt_date);
      }
    }

    // Only keep rows with exactly 10-digit mobile numbers
    const beforeFilter = extracted.length;
    const validRows = extracted.filter(r => {
      const clean = String(r.mobile_number || '').replace(/\D/g, '');
      r.mobile_number = clean;
      return clean.length === 10;
    });
    const invalidMobileCount = beforeFilter - validRows.length;
    if (validRows.length === 0) {
      return res.status(400).json({ message: 'No valid 10-digit mobile numbers found in file' });
    }

    const { deduped, duplicatesRemoved } = dedupRows(validRows);

    // Cross-batch dedup is applied PER-NGO: a mobile is skipped only for the
    // NGOs that already have it (old-data OD assignment, prior new_data row or
    // an earlier fresh distribution). NGOs that do NOT have it still receive it.
    const allMobiles = deduped.map(r => r.mobile_number);
    let freshData = false;
    let ngoStations = null;
    try { freshData = req.body.fresh_data === true || req.body.fresh_data === 'true'; } catch {}
    try { ngoStations = req.body.ngo_stations ? (typeof req.body.ngo_stations === 'string' ? JSON.parse(req.body.ngo_stations) : req.body.ngo_stations) : null; } catch {}

    if (freshData && ngoStations && typeof ngoStations === 'object' && Object.keys(ngoStations).length > 0) {
      const importBatchId = uuidv4();
      const ngoResults = {};
      let totalImported = 0;
      let totalAssigned = 0;
      let crossBatchDups = 0;
      const allNgoNames = Object.keys(ngoStations);

      for (const ngoName of allNgoNames) {
        const pickedStations = ngoStations[ngoName];
        if (!Array.isArray(pickedStations) || pickedStations.length === 0) continue;

        const ngoRow = (await db.from('ngos').select('id, name').eq('name', ngoName).maybeSingle()).data;
        if (!ngoRow) continue;
        const ngoId = ngoRow.id;

        // Per-NGO dedup: skip only the mobiles THIS NGO already has
        const existingForNgo = await getExistingMobilesForNgo(allMobiles, ngoName);
        const allowed = deduped.filter(r => !existingForNgo.has(r.mobile_number));
        crossBatchDups += deduped.length - allowed.length;

        // Insert rows into new_data for this NGO
        const dbRows = [];
        for (const r of allowed) {
          const row = {
            data_source_id,
            import_date: date,
            import_batch_id: importBatchId,
            mobile_number: r.mobile_number,
            name: r.name || null,
            category: r.category || '',
            amount: r.amount || 0,
            ngo: ngoName,
            data_category: r.data_category || bodyDataCategory || null,
          };
          if (fullSheet) {
            Object.assign(row, {
              transaction_date: r.transaction_date || null,
              bank_donor_name: r.bank_donor_name || null,
              agent_donor_name: r.agent_donor_name || null,
              mobile_2: r.mobile_2 || null,
              address_1: r.address_1 || null,
              address_2: r.address_2 || null,
              city: r.city || null,
              pin_code: r.pin_code || null,
              pan_number: r.pan_number || null,
              email: r.email || null,
              birth_date: r.birth_date || null,
              team: r.team || null,
              agent_name: r.fro_name || r.agent_name || null,
              mop: r.mop || null,
              received_bank: r.received_bank || null,
              payment_id_no: r.payment_id_no || null,
              donors_bank_name: r.donors_bank_name || null,
              receipt_no: r.receipt_no || null,
              receipt_date: r.receipt_date || null,
              receipt_time: r.receipt_time || null,
              project_supported: r.project_supported || null,
              account_of: r.account_of || null,
              branch: r.branch || null,
              station: r.station || null,
            });
          }
          dbRows.push(row);
        }

        // Insert in batches of 500
        const BATCH_SIZE = 500;
        let inserted = 0;
        for (let i = 0; i < dbRows.length; i += BATCH_SIZE) {
          const batch = dbRows.slice(i, i + BATCH_SIZE);
          const { data, error: insErr } = await db
            .from('new_data')
            .insert(batch)
            .select();
          if (insErr) throw insErr;
          inserted += (data || []).length;
        }
        totalImported += inserted;

        try {
          const ngoh = redis.hashKey([ngoName]);
          await redis.del(`v1:newdata:distinct_count:${ngoh}`);
        } catch (e) {
          // ignore
        }

        // Create donor_profiles for this NGO's fresh rows
        const profiles = allowed.map(row => ({
          mobile_number: row.mobile_number,
          name: row.name || null,
          bank_donor_name: row.bank_donor_name || null,
          agent_donor_name: row.agent_donor_name || null,
          mobile_2: row.mobile_2 || null,
          address_1: row.address_1 || null,
          address_2: row.address_2 || null,
          city: row.city || null,
          pin_code: row.pin_code || null,
          pan_number: row.pan_number || null,
          email: row.email || null,
          birth_date: row.birth_date || null,
          data_category: row.data_category || null,
          team: row.team || null,
          agent_name: row.agent_name || null,
          mop: row.mop || null,
          donors_bank_name: row.donors_bank_name || null,
          project_supported: row.project_supported || null,
          account_of: row.account_of || null,
          raw_data: row,
          import_batch_id: importBatchId,
          category: row.category || '',
          station: pickedStations[0] || null,
          ngo: ngoName,
          amount: row.amount || 0,
        }));

        try {
          await upsertDonorProfilesBatch(profiles, importBatchId);
        } catch (profileErr) {
          console.error(`Donor profile creation error for ${ngoName} (non-fatal):`, profileErr.message);
        }

        // Round-robin assign donors to picked stations
        try {
          const assignResult = await roundRobinAssignToStations(
            ngoName, ngoId, pickedStations, importBatchId, req.user?.id || 'system'
          );
          totalAssigned += assignResult.assigned;
          ngoResults[ngoName] = {
            imported: inserted,
            assigned: assignResult.assigned,
            station_breakdown: assignResult.stationBreakdown,
          };
        } catch (assignErr) {
          console.error(`Assignment error for ${ngoName} (non-fatal):`, assignErr.message);
          ngoResults[ngoName] = { imported: inserted, assigned: 0, station_breakdown: {} };
        }
      }

      return res.status(201).json({
        message: `Fresh data imported for ${allNgoNames.length} NGO(s)`,
        batch_id: importBatchId,
        total_in_file: extracted.length,
        invalid_mobile_count: invalidMobileCount,
        duplicates_removed: duplicatesRemoved,
        cross_batch_duplicates: crossBatchDups,
        imported: totalImported,
        assigned_donors: totalAssigned,
        ngo_results: ngoResults,
        ngos_used: allNgoNames.length,
        fresh_data: true,
      });
    }

    const { data: allNgos, error: nErr } = await db
      .from('ngos')
      .select('id, name')
      .eq('is_active', true);
    if (nErr) throw nErr;

    // Filter NGOs by selected ngo_ids if provided
    let selectedNgos = allNgos;
    if (ngo_ids) {
      const ids = Array.isArray(ngo_ids) ? ngo_ids : ngo_ids.split(',').map(s => s.trim());
      const numIds = ids.map(id => Number(id));
      selectedNgos = allNgos.filter(n => numIds.includes(n.id));
    }

    const importBatchId = uuidv4();

    // Send each record to selected NGOs (one row per NGO), skipping per NGO a
    // mobile that this specific NGO already has (old-data OD / earlier import).
    const ngoNames = selectedNgos.length > 0 ? selectedNgos.map(n => n.name) : ['Default'];
    const dbRows = [];
    let crossBatchDups = 0;

    for (const ngo of ngoNames) {
      const existingForNgo = await getExistingMobilesForNgo(allMobiles, ngo);
      for (const r of deduped) {
        if (existingForNgo.has(r.mobile_number)) {
          crossBatchDups++;
          continue;
        }
        const row = {
          data_source_id,
          import_date: date,
          import_batch_id: importBatchId,
          mobile_number: r.mobile_number,
          name: r.name || null,
          category: r.category || '',
          amount: r.amount || 0,
          ngo,
        };
        if (fullSheet) {
          Object.assign(row, {
            transaction_date: r.transaction_date || null,
            bank_donor_name: r.bank_donor_name || null,
            agent_donor_name: r.agent_donor_name || null,
            mobile_2: r.mobile_2 || null,
            address_1: r.address_1 || null,
            address_2: r.address_2 || null,
            city: r.city || null,
            pin_code: r.pin_code || null,
            pan_number: r.pan_number || null,
            email: r.email || null,
            birth_date: r.birth_date || null,
            data_category: r.data_category || null,
            team: r.team || null,
            agent_name: r.fro_name || r.agent_name || null,
            mop: r.mop || null,
            received_bank: r.received_bank || null,
            payment_id_no: r.payment_id_no || null,
            donors_bank_name: r.donors_bank_name || null,
            receipt_no: r.receipt_no || null,
            receipt_date: r.receipt_date || null,
            receipt_time: r.receipt_time || null,
            project_supported: r.project_supported || null,
            account_of: r.account_of || null,
            branch: r.branch || null,
            station: r.station || null,
          });
        }
        dbRows.push(row);
      }
    }

    // Insert in batches of 500 to avoid statement timeout
    const BATCH_SIZE = 500;
    let totalInserted = 0;
    for (let i = 0; i < dbRows.length; i += BATCH_SIZE) {
      const batch = dbRows.slice(i, i + BATCH_SIZE);
      const { data, error: insErr } = await db
        .from('new_data')
        .insert(batch)
        .select();
      if (insErr) throw insErr;
      totalInserted += (data || []).length;
    }

    // Build per-NGO stats
    const ngoCounts = {};
    for (const row of dbRows) {
      ngoCounts[row.ngo] = (ngoCounts[row.ngo] || 0) + 1;
    }
    const distribution = Object.entries(ngoCounts).map(([name, count]) => `${count} → ${name}`);

    // Auto-assign donors to FROs via stations (only if donor_profiles exist)
    let assignedDonors = 0;
    let stationBreakdown = {};
    try {
      const result = await autoAssignDonorsToStations(deduped, importBatchId, selectedNgos, req.user?.id || 'system');
      assignedDonors = result.totalAssigned;
      stationBreakdown = result.breakdown;
    } catch (assignErr) {
      console.error('Auto-assignment error (non-fatal):', assignErr.message);
    }

    return res.status(201).json({
      message: selectedNgos.length < allNgos.length
        ? `Data imported for ${selectedNgos.length} NGO(s) successfully`
        : 'Data imported and replicated to all active NGOs successfully',
      batch_id: importBatchId,
      total_in_file: extracted.length,
      invalid_mobile_count: invalidMobileCount,
      duplicates_removed: duplicatesRemoved,
      cross_batch_duplicates: crossBatchDups,
      imported: totalInserted,
      assigned_donors: assignedDonors,
      station_breakdown: stationBreakdown,
      distribution: distribution.join('; '),
      ngo_counts: ngoCounts,
      ngos_used: ngoNames.length,
      per_ngo_count: deduped.length,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadChunk = async (req, res) => {
  try {
    const { rows, ngo_ids, data_source_id, import_date, chunk_index, total_chunks, fresh_data, ngo_stations } = req.body;
    const bodyDataCategory = req.body.data_category || null;
    if (!rows || rows.length === 0 || !data_source_id || !import_date) {
      return res.status(400).json({ message: 'rows, data_source_id, and import_date are required' });
    }

    // Only keep rows with exactly 10-digit mobile numbers
    const beforeFilter = rows.length;
    const validRows = rows.filter(r => {
      const clean = String(r.mobile_number || '').replace(/\D/g, '');
      r.mobile_number = clean;
      return clean.length === 10;
    });
    const invalidMobileCount = beforeFilter - validRows.length;
    if (validRows.length === 0) {
      return res.json({ inserted: 0, invalid_mobile_count: invalidMobileCount, message: 'No valid 10-digit mobile numbers in chunk' });
    }

    const importBatchId = req.body.batch_id || uuidv4();
    const isFreshData = fresh_data === true || fresh_data === 'true';
    let parsedNgoStations = null;
    try { parsedNgoStations = ngo_stations ? (typeof ngo_stations === 'string' ? JSON.parse(ngo_stations) : ngo_stations) : null; } catch {}

    if (isFreshData && parsedNgoStations && typeof parsedNgoStations === 'object' && Object.keys(parsedNgoStations).length > 0) {
      // Fresh data mode: per-NGO dedup — skip only the mobiles this NGO already has
      const allMobileNumbers = validRows.map(r => r.mobile_number);
      let totalInserted = 0;
      let crossBatchDups = 0;
      const ngoResults = {};

      for (const [ngoName, pickedStations] of Object.entries(parsedNgoStations)) {
        if (!Array.isArray(pickedStations) || pickedStations.length === 0) continue;

        const existingForNgo = await getExistingMobilesForNgo(allMobileNumbers, ngoName);
        const allowed = validRows.filter(r => !existingForNgo.has(r.mobile_number));
        crossBatchDups += validRows.length - allowed.length;
        if (allowed.length === 0) continue;

        const dbRows = [];
        for (const r of allowed) {
          dbRows.push({
            data_source_id,
            import_date,
            import_batch_id: importBatchId,
            mobile_number: r.mobile_number,
            name: r.name || null,
            category: r.category || '',
            amount: resolveAmount(r.amount),
            ngo: ngoName,
            data_category: r.data_category || bodyDataCategory || null,
          });
        }

        // Dedup within chunk for this NGO
        const seen = new Set();
        const deduped = dbRows.filter(r => {
          const key = `${r.mobile_number}_${r.ngo}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        const BATCH_SIZE = 500;
        let inserted = 0;
        for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
          const batch = deduped.slice(i, i + BATCH_SIZE);
          const { data, error: insErr } = await db
            .from('new_data')
            .insert(batch)
            .select();
          if (insErr) throw insErr;
          inserted += (data || []).length;
        }
        totalInserted += inserted;

        // Assign on final chunk
        if (chunk_index === total_chunks - 1) {
          try {
            const ngoRow = (await db.from('ngos').select('id').eq('name', ngoName).maybeSingle()).data;
            if (ngoRow) {
              const assignResult = await roundRobinAssignToStations(
                ngoName, ngoRow.id, pickedStations, importBatchId, req.user?.id || 'system'
              );
              ngoResults[ngoName] = { imported: inserted, assigned: assignResult.assigned, station_breakdown: assignResult.stationBreakdown };
            }
          } catch (assignErr) {
            console.error(`Assignment error for ${ngoName} (non-fatal):`, assignErr.message);
            ngoResults[ngoName] = { imported: inserted, assigned: 0, station_breakdown: {} };
          }
        }
      }

      return res.json({
        inserted: totalInserted,
        unique_donors: validRows.length,
        invalid_mobile_count: invalidMobileCount,
        cross_batch_duplicates: crossBatchDups,
        batch_id: importBatchId,
        chunk_index,
        total_chunks,
        ngo_results: ngoResults,
        done: chunk_index === total_chunks - 1,
        fresh_data: true,
      });
    }

    // Standard mode: distribute to all NGOs
    const { data: allNgos } = await db.from('ngos').select('id, name').eq('is_active', true);
    let selectedNgos = allNgos || [];
    if (ngo_ids && ngo_ids.length > 0) {
      selectedNgos = (allNgos || []).filter(n => ngo_ids.includes(n.id));
    }

    const ngoNames = selectedNgos.length > 0 ? selectedNgos.map(n => n.name) : ['Default'];

    // Cross-batch dedup per NGO: skip a mobile only for the ones that already have it
    const allMobileNumbers = validRows.map(r => r.mobile_number);
    const dbRows = [];
    let crossBatchDups = 0;

    for (const ngo of ngoNames) {
      const existingForNgo = await getExistingMobilesForNgo(allMobileNumbers, ngo);
      for (const r of validRows) {
        if (existingForNgo.has(r.mobile_number)) {
          crossBatchDups++;
          continue;
        }
        dbRows.push({
          data_source_id,
          import_date,
          import_batch_id: importBatchId,
          mobile_number: r.mobile_number,
          name: r.name || null,
          category: r.category || '',
          amount: resolveAmount(r.amount),
          ngo,
          data_category: r.data_category || bodyDataCategory || null,
        });
      }
    }

    if (dbRows.length === 0) {
      return res.json({
        inserted: 0,
        unique_donors: 0,
        invalid_mobile_count: invalidMobileCount,
        cross_batch_duplicates: crossBatchDups,
        batch_id: importBatchId,
        chunk_index,
        total_chunks,
        done: chunk_index === total_chunks - 1,
      });
    }

    // Dedup within chunk
    const seen = new Set();
    const deduped = dbRows.filter(r => {
      const key = `${r.mobile_number}_${r.ngo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const BATCH_SIZE = 500;
    let inserted = 0;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const { data, error: insErr } = await db
        .from('new_data')
        .insert(batch)
        .select();
      if (insErr) throw insErr;
      inserted += (data || []).length;
    }

    const ngoCounts = {};
    for (const row of deduped) {
      ngoCounts[row.ngo] = (ngoCounts[row.ngo] || 0) + 1;
    }
    const uniqueDonors = new Set(deduped.map(r => r.mobile_number)).size;

    return res.json({
      inserted,
      unique_donors: uniqueDonors,
      invalid_mobile_count: invalidMobileCount,
      cross_batch_duplicates: crossBatchDups,
      batch_id: importBatchId,
      chunk_index,
      total_chunks,
      ngo_counts: ngoCounts,
      done: chunk_index === total_chunks - 1,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadOldDataImport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'File is required' });
    }
    const { date, data_source_id, sheets } = req.body;
    const bodyDataCategory = req.body.data_category || null;
    if (!date || !data_source_id) {
      return res.status(400).json({ message: 'Date and data source are required' });
    }

    const sheetFilter = sheets ? (Array.isArray(sheets) ? sheets : sheets.split(',').map(s => s.trim())) : undefined;
    const { rows: extracted, fullSheet } = parseImportFile(req.file.buffer, { sheets: sheetFilter });
    if (extracted.length === 0) {
      return res.status(400).json({ message: 'File is empty or has no data rows' });
    }

    if (fullSheet) {
      for (const r of extracted) {
        r.transaction_date = normalizeDate(r.transaction_date);
        r.birth_date = normalizeDate(r.birth_date);
        r.receipt_date = normalizeDate(r.receipt_date);
      }
    }

    // Only keep rows with exactly 10-digit mobile numbers
    const beforeFilter = extracted.length;
    const validRows = extracted.filter(r => {
      const clean = String(r.mobile_number || '').replace(/\D/g, '');
      r.mobile_number = clean;
      return clean.length === 10;
    });
    const invalidMobileCount = beforeFilter - validRows.length;
    if (validRows.length === 0) {
      return res.status(400).json({ message: 'No valid 10-digit mobile numbers found in file' });
    }

    const { data: ngos, error: nErr } = await db
      .from('ngos')
      .select('id, name')
      .eq('is_active', true);
    if (nErr) throw nErr;

    const importBatchId = uuidv4();

    // Send to ALL active NGOs — per-NGO dedup: skip a mobile only for the NGOs
    // that already have it (old-data OD assignment / prior import), keep it for
    // NGOs that do NOT have it yet.
    const ngoNames = ngos && ngos.length > 0 ? ngos.map(n => n.name) : ['Default'];
    const allMobileNumbers = validRows.map(r => r.mobile_number);
    const dbRows = [];
    let crossBatchDups = 0;

    for (const ngo of ngoNames) {
      const existingForNgo = await getExistingMobilesForNgo(allMobileNumbers, ngo);
      for (const r of validRows) {
        if (existingForNgo.has(r.mobile_number)) {
          crossBatchDups++;
          continue;
        }
        const row = {
          data_source_id,
          import_date: date,
          import_batch_id: importBatchId,
          mobile_number: r.mobile_number,
          name: r.name || null,
          category: r.category || '',
          amount: r.amount || 0,
          ngo,
          data_category: r.data_category || bodyDataCategory || null,
        };
        if (fullSheet) {
          Object.assign(row, {
            transaction_date: r.transaction_date || null,
            bank_donor_name: r.bank_donor_name || null,
            agent_donor_name: r.agent_donor_name || null,
            mobile_2: r.mobile_2 || null,
            address_1: r.address_1 || null,
            address_2: r.address_2 || null,
            city: r.city || null,
            pin_code: r.pin_code || null,
            pan_number: r.pan_number || null,
            email: r.email || null,
            birth_date: r.birth_date || null,
            team: r.team || null,
            agent_name: r.fro_name || r.agent_name || null,
            mop: r.mop || null,
            received_bank: r.received_bank || null,
            payment_id_no: r.payment_id_no || null,
            donors_bank_name: r.donors_bank_name || null,
            receipt_no: r.receipt_no || null,
            receipt_date: r.receipt_date || null,
            receipt_time: r.receipt_time || null,
            project_supported: r.project_supported || null,
            account_of: r.account_of || null,
            branch: r.branch || null,
            station: r.station || null,
          });
        }
        dbRows.push(row);
      }
    }

    const uniqueImportedMobiles = new Set(dbRows.map(r => r.mobile_number)).size;

    const inserted = await insertNewDataBatch(dbRows);

    let profilesCreated = 0;
    const errors = [];
    // Only create profiles for first NGO entry to avoid duplicates
    const firstNgoName = ngoNames[0] || 'Default';
    const firstNgoExisting = await getExistingMobilesForNgo(allMobileNumbers, firstNgoName);
    const profiles = validRows
      .filter(row => !firstNgoExisting.has(row.mobile_number))
      .map(row => ({
      mobile_number: row.mobile_number,
      name: row.name || null,
      bank_donor_name: row.bank_donor_name || null,
      agent_donor_name: row.agent_donor_name || null,
      mobile_2: row.mobile_2 || null,
      address_1: row.address_1 || null,
      address_2: row.address_2 || null,
      city: row.city || null,
      pin_code: row.pin_code || null,
      pan_number: row.pan_number || null,
      email: row.email || null,
      birth_date: row.birth_date || null,
      data_category: row.data_category || null,
      team: row.team || null,
      agent_name: row.agent_name || null,
      mop: row.mop || null,
      donors_bank_name: row.donors_bank_name || null,
      project_supported: row.project_supported || null,
      account_of: row.account_of || null,
      raw_data: row,
      import_batch_id: importBatchId,
      category: row.category || '',
      amount: row.amount || 0,
      transaction_date: row.transaction_date || null,
      station: row.station || null,
      ngo: firstNgoName,
    }));
    try {
      profilesCreated = await upsertDonorProfilesBatch(profiles, importBatchId);
    } catch (profileErr) {
      console.error('Donor profile bulk upsert failed:', profileErr.message);
      errors.push({ row: 'bulk', reason: profileErr.message });
    }

    // Auto-assign donors to FROs via stations
    let assignedDonors = 0;
    let stationBreakdown = {};
    try {
      const result = await autoAssignDonorsToStations(validRows, importBatchId, ngos, req.user?.id || 'system');
      assignedDonors = result.totalAssigned;
      stationBreakdown = result.breakdown;
    } catch (assignErr) {
      console.error('Auto-assignment error (non-fatal):', assignErr.message);
    }

    return res.status(201).json({
      message: assignedDonors > 0
        ? `Old data imported. ${assignedDonors} donors auto-assigned to FROs.`
        : 'Old data imported successfully (no FROs available for auto-assignment)',
      type: fullSheet ? 'full' : 'quick',
      batch_id: importBatchId,
      total_in_file: extracted.length,
      invalid_mobile_count: invalidMobileCount,
      cross_batch_duplicates: crossBatchDups,
      valid_rows: uniqueImportedMobiles,
      imported: inserted.length,
      profiles_created: profilesCreated,
      assigned_donors: assignedDonors,
      station_breakdown: stationBreakdown,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listImportBatches = async (req, res) => {
  try {
    const batches = await getImportBatches();
    const enriched = await Promise.all(
      batches.map(async (b) => {
        const count = await getBatchCount(b.import_batch_id);
        return { ...b, record_count: count };
      })
    );
    return res.json(enriched);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getImportBatch = async (req, res) => {
  try {
    const batch = await getBatchById(req.params.id);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    // Preview is bounded: a multi-hundred-thousand-row import batch must not be
    // materialized into one JSON response (RAM + client hang). Fetch the first
    // page only; export remains fully paginated out-of-band if needed.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const records = await getBatchRecords(req.params.id, { limit, offset });
    const total = await getBatchCount(req.params.id);
    return res.json({ ...batch, records, total });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const exportBatch = async (req, res) => {
  try {
    const records = await getBatchRecords(req.params.id);
    if (records.length === 0) {
      return res.status(404).json({ message: 'No records found for this batch' });
    }

    const exportData = records.map((r) => ({
      Name: r.name || '',
      Mobile: r.mobile_number,
      Category: r.category,
      Amount: r.amount,
      'Transaction Date': r.transaction_date || '',
      'Bank Donor Name': r.bank_donor_name || '',
      'Agent Donor Name': r.agent_donor_name || '',
      'Mobile 2': r.mobile_2 || '',
      Address: r.address_1 || '',
      City: r.city || '',
      'Pin Code': r.pin_code || '',
      'PAN No': r.pan_number || '',
      Email: r.email || '',
      'Birth Date': r.birth_date || '',
      Team: r.team || '',
      'Agent Name': r.agent_name || '',
      MOP: r.mop || '',
      'Received Bank': r.received_bank || '',
      'Payment ID': r.payment_id_no || '',
      "Donor's Bank": r.donors_bank_name || '',
      'Receipt No': r.receipt_no || '',
      'Receipt Date': r.receipt_date || '',
      Project: r.project_supported || '',
      'Account Of': r.account_of || '',
      Branch: r.branch || '',
    }));

    const XLSX = (await import('xlsx')).default;
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Exported');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=import-batch-${req.params.id}.xlsx`);
    return res.send(buf);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const downloadTestSheet = async (req, res) => {
  try {
    const XLSX = (await import('xlsx')).default;
    const data = [
      { Name: 'Amit Sharma', Mobile: '9876543210', Category: 'NGO001', Amount: 15000 },
      { Name: 'Priya Verma', Mobile: '9876543211', Category: 'NGO002', Amount: 12000 },
      { Name: 'Rahul Singh', Mobile: '9876543212', Category: 'NGO001', Amount: 8000 },
      { Name: 'Sneha Patel', Mobile: '9876543213', Category: 'NGO003', Amount: 20000 },
      { Name: 'Vikram Joshi', Mobile: '9876543214', Category: 'NGO002', Amount: 5000 },
      { Name: 'Amit Sharma', Mobile: '9876543210', Category: 'NGO001', Amount: 18000 },
      { Name: 'Neha Gupta', Mobile: '9876543215', Category: 'NGO001', Amount: 7500 },
      { Name: 'Rahul Singh', Mobile: '9876543212', Category: 'NGO001', Amount: 6000 },
      { Name: 'Deepak Kumar', Mobile: '9876543216', Category: 'NGO003', Amount: 22000 },
      { Name: 'Pooja Mehta', Mobile: '9876543217', Category: 'NGO002', Amount: 3000 },
      { Name: 'Priya Verma', Mobile: '9876543211', Category: 'NGO002', Amount: 14000 },
      { Name: 'Ankit Tiwari', Mobile: '9876543218', Category: 'NGO001', Amount: 9500 },
      { Name: 'Sneha Patel', Mobile: '9876543213', Category: 'NGO003', Amount: 16000 },
      { Name: 'Ravi Desai', Mobile: '9876543219', Category: 'NGO002', Amount: 11000 },
      { Name: 'Kiran Rao', Mobile: '9876543220', Category: 'NGO001', Amount: 6500 },
    ];
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Test Data');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=data-import-test.xlsx');
    return res.send(buf);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const copyDonorsToNgos = async (req, res) => {
  try {
    const { source_ngo_id, target_ngo_ids, filter, mobile_numbers } = req.body;
    if (!source_ngo_id || !target_ngo_ids || target_ngo_ids.length === 0) {
      return res.status(400).json({ message: 'source_ngo_id and target_ngo_ids are required' });
    }

    // Get source NGO name
    const { data: sourceNgo } = await db.from('ngos').select('name').eq('id', source_ngo_id).single();
    if (!sourceNgo) return res.status(404).json({ message: 'Source NGO not found' });
    const sourceNgoName = sourceNgo.name;

    // Get target NGO names
    const { data: targetNgos } = await db.from('ngos').select('id, name').in('id', target_ngo_ids.map(Number));
    if (!targetNgos || targetNgos.length === 0) {
      return res.status(400).json({ message: 'No valid target NGOs found' });
    }

    // Determine which mobiles to copy
    let mobilesToCopy = [];

    if (mobile_numbers && mobile_numbers.length > 0) {
      mobilesToCopy = mobile_numbers;
    } else {
      // Fetch from donor_profiles that have fro_assignments for source NGO
      const { data: donorProfiles } = await db
        .from('donor_profiles')
        .select('mobile_number');

      if (!donorProfiles || donorProfiles.length === 0) {
        return res.json({ message: 'No donors found in source NGO', copied: 0, details: [] });
      }

      const allMobiles = donorProfiles.map(d => d.mobile_number).filter(Boolean);
      const uniqueMobiles = [...new Set(allMobiles)];

      if (uniqueMobiles.length === 0) {
        return res.json({ message: 'No donors with mobile numbers found', copied: 0, details: [] });
      }

      // If filter is 'assigned', only include mobiles with fro_assignments for source NGO
      if (filter === 'assigned') {
        const { data: sourceAssignments } = await db
          .from('fro_assignments')
          .select('donor_id')
          .eq('ngo_id', source_ngo_id)
          .not('status', 'eq', 'reassigned');

        const assignedDonorIds = new Set((sourceAssignments || []).map(a => a.donor_id));
        const { data: assignedProfiles } = await db
          .from('donor_profiles')
          .select('mobile_number')
          .in('id', [...assignedDonorIds]);

        mobilesToCopy = [...new Set((assignedProfiles || []).map(d => d.mobile_number).filter(Boolean))];
      } else if (filter === 'new') {
        const { data: sourceAssignments } = await db
          .from('fro_assignments')
          .select('donor_id')
          .eq('ngo_id', source_ngo_id)
          .not('status', 'eq', 'reassigned');

        const assignedDonorIds = new Set((sourceAssignments || []).map(a => a.donor_id));
        const { data: unassignedProfiles } = await db
          .from('donor_profiles')
          .select('mobile_number')
          .not('id', 'in', [...assignedDonorIds]);

        mobilesToCopy = [...new Set((unassignedProfiles || []).map(d => d.mobile_number).filter(Boolean))];
      } else {
        mobilesToCopy = uniqueMobiles;
      }
    }

    if (mobilesToCopy.length === 0) {
      return res.json({ message: 'No donors to copy', copied: 0, details: [] });
    }

    // Fetch source new_data rows for these mobiles
    const { data: sourceRows } = await db
      .from('new_data')
      .select('*')
      .eq('ngo', sourceNgoName)
      .in('mobile_number', mobilesToCopy);

    if (!sourceRows || sourceRows.length === 0) {
      return res.json({ message: 'No new_data rows found for source NGO', copied: 0, details: [] });
    }

    // Group by mobile to dedup (keep latest row per mobile)
    const latestPerMobile = {};
    for (const row of sourceRows) {
      if (!latestPerMobile[row.mobile_number]) latestPerMobile[row.mobile_number] = row;
    }

    const importBatchId = uuidv4();
    const results = [];

    for (const targetNgo of targetNgos) {
      // Check which mobiles already exist for target NGO
      const { data: existingTarget } = await db
        .from('new_data')
        .select('mobile_number')
        .eq('ngo', targetNgo.name);

      const existingTargetMobiles = new Set((existingTarget || []).map(r => r.mobile_number));

      const toInsert = [];
      let mobileIteration = 0;
      for (const mobile of mobilesToCopy) {
        mobileIteration += 1;
        if (mobileIteration % 200 === 0) await yieldNow();
        if (!existingTargetMobiles.has(mobile)) {
          const sourceRow = latestPerMobile[mobile];
          if (sourceRow) {
            const row = { ...sourceRow };
            delete row.id;
            delete row.created_at;
            row.ngo = targetNgo.name;
            row.import_batch_id = importBatchId;
            row.status = null;
            toInsert.push(row);
          }
        }
      }

      if (toInsert.length > 0) {
        // Insert in bounded chunks so a huge copy never materializes the whole
        // array in one VALUES clause or blocks the event loop the whole time.
        for (let i = 0; i < toInsert.length; i += CHUNK) {
          await insertNewDataBatch(toInsert.slice(i, i + CHUNK));
          await yieldNow();
        }
      }
      results.push({ ngo: targetNgo.name, ngo_id: targetNgo.id, copied: toInsert.length });
    }

    return res.json({
      message: `Copied donors to ${targetNgos.length} NGO(s)`,
      batch_id: importBatchId,
      total_mobiles: mobilesToCopy.length,
      details: results,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const downloadSample = async (req, res) => {
  try {
    const XLSX = (await import('xlsx')).default;
    const full = [
      {
        'Transaction Date': '01-04-2025',
        'Bank Donar Name': 'Rajesh Kumar',
        'Agent donar name': 'Amit Sharma',
        'Mobile No.': '9876543210',
        'Address-1': '123, MG Road',
        'Address-2': 'Near Market',
        City: 'Mumbai',
        'Pin Code': '400001',
        'Pan. No.': 'ABCDE1234F',
        'Mail Id': 'rajesh@email.com',
        'Birth Date': '15-08-1985',
        'Data Category': 'NGO001',
        Amount: 15000,
      },
    ];
    const ws = XLSX.utils.json_to_sheet(full);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sample');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=data-import-sample.xlsx');
    return res.send(buf);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


