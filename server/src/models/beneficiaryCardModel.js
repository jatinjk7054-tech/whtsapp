import db from '../config/db.js';
import { v4 as uuidv4 } from 'uuid';

export const issueCard = async (beneficiaryId, cardType = 'QR', issuedBy) => {
  const cardNumber = `CARD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const qrToken = uuidv4();

  const data = {
    beneficiary_id: beneficiaryId,
    card_type: cardType,
    card_number: cardNumber,
    qr_token: qrToken,
    status: 'ACTIVE',
    issued_at: new Date().toISOString(),
    issued_by: issuedBy || null,
  };

  if (cardType === 'RFID') {
    data.rfid_uid = `RFID-${uuidv4().slice(0, 8).toUpperCase()}`;
  }

  const { data: result, error } = await db
    .from('beneficiary_cards')
    .insert(data)
    .select('*')
    .single();
  if (error) throw error;
  return result;
};

export const getCards = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_cards')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .order('issued_at', { ascending: false });
  if (error) throw error;
  return data || [];
};

export const getActiveCard = async (beneficiaryId) => {
  const { data, error } = await db
    .from('beneficiary_cards')
    .select('*')
    .eq('beneficiary_id', beneficiaryId)
    .eq('status', 'ACTIVE')
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
};

export const replaceCard = async (cardId, reason, replacedBy) => {
  // Deactivate old card
  const { data: oldCard } = await db
    .from('beneficiary_cards')
    .select('beneficiary_id, card_type')
    .eq('id', cardId)
    .single();

  if (!oldCard) throw new Error('Card not found');

  await db
    .from('beneficiary_cards')
    .update({ status: 'REPLACED', replaced_at: new Date().toISOString(), replacement_reason: reason })
    .eq('id', cardId);

  // Issue new card
  return await issueCard(oldCard.beneficiary_id, oldCard.card_type, replacedBy);
};

export const revokeCard = async (cardId) => {
  const { data, error } = await db
    .from('beneficiary_cards')
    .update({ status: 'REVOKED' })
    .eq('id', cardId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

export const findByQRToken = async (qrToken) => {
  const { data, error } = await db
    .from('beneficiary_cards')
    .select('*, beneficiaries(id, beneficiary_code, full_name, status)')
    .eq('qr_token', qrToken)
    .eq('status', 'ACTIVE')
    .single();
  if (error) return null;
  return data;
};

export const findByRFID = async (rfidUid) => {
  const { data, error } = await db
    .from('beneficiary_cards')
    .select('*, beneficiaries(id, beneficiary_code, full_name, status)')
    .eq('rfid_uid', rfidUid)
    .eq('status', 'ACTIVE')
    .single();
  if (error) return null;
  return data;
};
