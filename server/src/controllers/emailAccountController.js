import * as AccountModel from '../models/emailAccountModel.js';

export async function list(req, res) {
  try {
    const accounts = await AccountModel.listAccounts();
    return res.json(accounts);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function create(req, res) {
  try {
    const { name, email, app_password, imap_host, imap_port, is_active } = req.body;
    if (!name || !email || !app_password) {
      return res.status(400).json({ message: 'Name, email, and app password are required' });
    }
    const account = await AccountModel.createAccount({ name, email, app_password, imap_host, imap_port, is_active });
    return res.status(201).json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function update(req, res) {
  try {
    const { id } = req.params;
    const account = await AccountModel.updateAccount(Number(id), req.body);
    return res.json(account);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}

export async function remove(req, res) {
  try {
    const { id } = req.params;
    await AccountModel.deleteAccount(Number(id));
    return res.json({ message: 'Account deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
}
