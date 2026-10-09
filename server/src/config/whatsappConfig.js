import dotenv from 'dotenv';
dotenv.config();

const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

if (!phoneNumberId || !accessToken) {
  console.error('CRITICAL: WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set in environment variables');
}

const whatsappConfig = {
  phoneNumberId,
  accessToken,
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
  receiptTemplate: process.env.WHATSAPP_RECEIPT_TEMPLATE || 'bsct_receipt',
  enabled: !!(phoneNumberId && accessToken),
  wabaId: process.env.WHATSAPP_WABA_ID,
  whatsappTemplateName: process.env.WHATSAPP_TEMPLATE_NAME || 'bsct_receipt',
  templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
};

export default whatsappConfig;
