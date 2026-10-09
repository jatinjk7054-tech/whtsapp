import { importScrapedBatch, getScraperStatus, listNgoProjectCodes, resolveProjectCode } from '../services/paymentScraperService.js';
import db from '../config/db.js';

export const deviceImport = async (req, res) => {
  try {
    const { project_id, run_id, device_label, transactions = [] } = req.body || {};

    if (!project_id) return res.status(400).json({ message: 'project_id is required' });
    if (!Array.isArray(transactions)) return res.status(400).json({ message: 'transactions must be an array' });

    const result = await importScrapedBatch({
      projectId: project_id,
      runId: run_id || `${device_label || 'device'}-${Date.now()}`,
      deviceLabel: device_label || 'Unknown device',
      transactions,
    });

    return res.json(result);
  } catch (error) {
    console.error('Scraper device import error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const status = async (req, res) => {
  try {
    const result = await getScraperStatus();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const runs = async (req, res) => {
  try {
    const { data, error } = await db
      .from('scraper_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return res.json({ runs: data || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const runDetail = async (req, res) => {
  try {
    const { runId } = req.params;
    const { data: run, error: rErr } = await db
      .from('scraper_runs')
      .select('*')
      .eq('run_id', runId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!run) return res.status(404).json({ message: 'Run not found' });

    const { data: entries, error: eErr } = await db
      .from('scraper_run_entries')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (eErr) throw eErr;

    return res.json({ run, entries: entries || [] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const ngos = async (req, res) => {
  try {
    const result = await listNgoProjectCodes();
    return res.json({ ngos: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const sources = async (req, res) => {
  try {
    const { data, error } = await db
      .from('bank_audit_sources')
      .select('id, name, kind, is_active')
      .order('sort_order');
    if (error) throw error;
    const banks = (data || []).filter((s) => s.kind === 'bank').map((s) => s.name);
    const mops = (data || []).filter((s) => s.kind === 'mop').map((s) => s.name);
    return res.json({ banks, mops });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const knownRefs = async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ message: 'projectId is required' });

    const project = (await resolveProjectCode(projectId)) || projectId;

    const { data, error } = await db
      .from('bank_audit_entries')
      .select('payment_id')
      .eq('project_id', project)
      .not('payment_id', 'is', null)
      .limit(5000);
    if (error) throw error;

    const refs = [...new Set((data || []).map((r) => (r.payment_id || '').replace(/\s+/g, '')).filter(Boolean))];
    return res.json({ project, refs });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};