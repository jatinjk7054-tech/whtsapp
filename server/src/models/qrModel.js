import db from '../config/db.js';

export const createQRCode = async (qrData) => {
  const { data, error } = await db
    .from('qr_codes')
    .insert([qrData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getAllQRCodes = async () => {
  const { data, error } = await db
    .from('qr_codes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
};

export const getQRByCode = async (code) => {
  const { data, error } = await db
    .from('qr_codes')
    .select('*')
    .eq('code', code)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const deleteQRCode = async (id) => {
  const { error } = await db
    .from('qr_codes')
    .delete()
    .eq('id', id);
  if (error) throw error;
  return { message: 'QR code deleted' };
};
