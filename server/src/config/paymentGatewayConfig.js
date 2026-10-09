import dotenv from 'dotenv';
dotenv.config();

const config = {
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    enabled: process.env.RAZORPAY_ENABLED === 'true',
  },
  paytm: {
    merchantId: process.env.PAYTM_MERCHANT_ID || '',
    merchantKey: process.env.PAYTM_MERCHANT_KEY || '',
    webhookSecret: process.env.PAYTM_WEBHOOK_SECRET || '',
    enabled: process.env.PAYTM_ENABLED === 'true',
  },
};

export default config;
