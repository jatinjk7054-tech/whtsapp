import { listAccounts, getAccountById, createAccount, updateAccount, deleteAccount } from '../models/whatsappAccountModel.js';

export async function list(req, res) {
  try {
    const accounts = await listAccounts();
    return res.json(accounts);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function getById(req, res) {
  try {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found' });
    return res.json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function create(req, res) {
  try {
    const { name, project, phone_number_id, access_token, waba_id, template_name, template_language, is_active, is_default } = req.body;
    if (!name || !project || !phone_number_id || !access_token || !waba_id) {
      return res.status(400).json({ message: 'name, project, phone_number_id, access_token, and waba_id are required' });
    }
    const account = await createAccount({ name, project, phone_number_id, access_token, waba_id, template_name, template_language, is_active, is_default });
    return res.status(201).json(account);
  } catch (error) {
    if (error.message.includes('already exists')) return res.status(409).json({ message: error.message });
    return res.status(500).json({ message: error.message });
  }
}

export async function update(req, res) {
  try {
    const existing = await getAccountById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Account not found' });

    const account = await updateAccount(req.params.id, req.body);
    return res.json(account);
  } catch (error) {
    if (error.message.includes('already exists')) return res.status(409).json({ message: error.message });
    return res.status(500).json({ message: error.message });
  }
}

export async function remove(req, res) {
  try {
    const existing = await getAccountById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Account not found' });

    await deleteAccount(req.params.id);
    return res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
