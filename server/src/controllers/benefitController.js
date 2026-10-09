import { createBenefit, listBenefits, getBenefitById, updateBenefit, setEligibilityRules, getEligibilityRules } from '../models/benefitModel.js';

export const createNewBenefit = async (req, res) => {
  try {
    const { name, description, category } = req.body;
    if (!name) return res.status(400).json({ message: 'Benefit name is required' });
    const benefit = await createBenefit({ name, description, category });
    return res.status(201).json({ message: 'Benefit created', benefit });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAllBenefits = async (req, res) => {
  try {
    const benefits = await listBenefits();
    return res.json(benefits);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBenefit = async (req, res) => {
  try {
    const benefit = await getBenefitById(req.params.id);
    if (!benefit) return res.status(404).json({ message: 'Benefit not found' });
    const rules = await getEligibilityRules(benefit.id);
    return res.json({ ...benefit, eligibility_rules: rules });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateBenefitController = async (req, res) => {
  try {
    const benefit = await updateBenefit(req.params.id, req.body);
    return res.json({ message: 'Benefit updated', benefit });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const setBenefitEligibility = async (req, res) => {
  try {
    const { rules } = req.body;
    const result = await setEligibilityRules(req.params.id, rules);
    return res.json({ message: 'Eligibility rules updated', rules: result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getBenefitEligibility = async (req, res) => {
  try {
    const rules = await getEligibilityRules(req.params.id);
    return res.json(rules);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
