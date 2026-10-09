import dotenv from 'dotenv';
dotenv.config();

const emailConfig = {
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  },
  imapMailbox: process.env.IMAP_MAILBOX || 'INBOX',
  pollIntervalMinutes: parseInt(process.env.IMAP_POLL_INTERVAL || '5'),
  enabled: process.env.IMAP_ENABLED === 'true',
};

export default emailConfig;
