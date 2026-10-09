import {
  createDistribution, addDistributionItem, getDistributionById,
  listDistributions, reverseDistribution, generateDistributionNumber,
  getBeneficiaryDistributionHistory,
} from '../models/distributionModel.js';
import { checkEligibility, getBenefitById } from '../models/benefitModel.js';
import { logAuditEvent } from '../models/auditLogModel.js';
import db from '../config/db.js';

export const issueBenefit = async (req, res) => {
  try {
    const { beneficiary_id, program_id, items, remarks } = req.body;
    if (!beneficiary_id || !items || items.length === 0) {
      return res.status(400).json({ message: 'beneficiary_id and items are required' });
    }

    // Verify beneficiary exists and is active
    const { data: beneficiary } = await db
      .from('beneficiaries')
      .select('id, beneficiary_code, full_name, status')
      .eq('id', beneficiary_id)
      .single();

    if (!beneficiary) return res.status(404).json({ message: 'Beneficiary not found' });
    if (beneficiary.status !== 'ACTIVE') {
      return res.status(400).json({ message: `Beneficiary is ${beneficiary.status}` });
    }

    // Check eligibility for each benefit item
    for (const item of items) {
      const eligibility = await checkEligibility(beneficiary_id, item.benefit_id);
      if (!eligibility.eligible) {
        return res.status(400).json({
          message: `Not eligible for benefit: ${eligibility.reason}`,
          benefit_id: item.benefit_id,
        });
      }
    }

    // Create distribution in transaction
    const result = await db.transaction(async ({ from }) => {
      const distribution_number = await generateDistributionNumber();

      const { data: distribution, error: distErr } = await from('benefit_distributions')
        .insert({
          distribution_number,
          beneficiary_id,
          program_id: program_id || null,
          distributed_by: req.user?.name || req.user?.email || 'system',
          location_name: req.body.location_name || null,
          distribution_date: new Date().toISOString(),
          status: 'COMPLETED',
          remarks,
        })
        .select('*')
        .single();
      if (distErr) throw distErr;

      for (const item of items) {
        const { error: itemErr } = await from('benefit_distribution_items')
          .insert({
            distribution_id: distribution.id,
            benefit_id: item.benefit_id,
            inventory_item_id: item.inventory_item_id || null,
            quantity: item.quantity || 1,
            unit: item.unit || null,
            remarks: item.remarks || null,
          });
        if (itemErr) throw itemErr;
      }

      return distribution;
    });

    await logAuditEvent({
      entity_type: 'distribution', entity_id: result.id,
      beneficiary_id, action: 'BENEFIT_ISSUED',
      details: { distribution_number: result.distribution_number, items: items.map(i => i.benefit_id) },
      performed_by: req.user?.name || 'system',
    });

    return res.status(201).json({ message: 'Benefit issued', distribution: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDistribution = async (req, res) => {
  try {
    const distribution = await getDistributionById(req.params.id);
    if (!distribution) return res.status(404).json({ message: 'Distribution not found' });
    return res.json(distribution);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllDistributions = async (req, res) => {
  try {
    const { page, pageSize, beneficiary_id, program_id, benefit_id, from_date, to_date, status } = req.query;
    const result = await listDistributions({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 25,
      beneficiary_id: beneficiary_id ? parseInt(beneficiary_id) : undefined,
      program_id: program_id ? parseInt(program_id) : undefined,
      benefit_id: benefit_id ? parseInt(benefit_id) : undefined,
      from_date, to_date, status,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const reverseDistributionController = async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await reverseDistribution(req.params.id, reason);

    await logAuditEvent({
      entity_type: 'distribution', entity_id: result.id,
      beneficiary_id: result.beneficiary_id, action: 'DISTRIBUTION_REVERSED',
      details: { reason }, performed_by: req.user?.name || 'system',
    });

    return res.json({ message: 'Distribution reversed', distribution: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBeneficiaryHistory = async (req, res) => {
  try {
    const history = await getBeneficiaryDistributionHistory(req.params.id);
    return res.json(history);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
