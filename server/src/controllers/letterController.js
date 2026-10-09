import {
  createTemplate,
  getAllTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
  createGeneratedLetter,
  getGeneratedLetters,
  getGeneratedLettersByWorkerId,
  getGeneratedLetterById,
} from '../models/letterModel.js';
import { getWorkerById } from '../models/workerModel.js';

const SAMPLE_TEMPLATES = [
  {
    category: 'joining',
    title: 'Joining Letter',
    variables: ['employee_name', 'designation', 'department', 'joining_date', 'reporting_manager', 'location', 'company_name'],
    html_content: `<!DOCTYPE html>
<html>
<head><style>
body { font-family: 'Inter', Arial, sans-serif; margin: 40px; color: #333; }
.header { text-align: center; margin-bottom: 30px; }
.header h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
.header h2 { color: #666; font-weight: normal; font-size: 16px; margin: 5px 0 0; }
.date { text-align: right; margin-bottom: 20px; color: #666; }
.subject { font-weight: bold; margin-bottom: 20px; }
.content p { line-height: 1.8; margin-bottom: 12px; }
.signature { margin-top: 40px; }
.signature p { margin: 5px 0; }
.footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
<div class="header">
  <h1>{company_name}</h1>
  <h2>Letter of Appointment</h2>
</div>
<div class="date">Date: {joining_date}</div>
<div class="subject">Subject: Appointment as {designation}</div>
<div class="content">
  <p>Dear {employee_name},</p>
  <p>We are pleased to inform you that you have been appointed as <strong>{designation}</strong> in the <strong>{department}</strong> department at {company_name}.</p>
  <p>Your date of joining will be <strong>{joining_date}</strong>. You will be reporting to <strong>{reporting_manager}</strong> at our {location} office.</p>
  <p>We look forward to having you as part of our team and wish you a successful tenure with us.</p>
  <p>Please report to the HR department on your joining date with the necessary documents for verification.</p>
</div>
<div class="signature">
  <p>Yours sincerely,</p>
  <p><strong>{reporting_manager}</strong></p>
  <p>{company_name}</p>
</div>
<div class="footer">
  <p>This is a computer-generated document. No signature is required.</p>
</div>
</body>
</html>`,
  },
  {
    category: 'offer',
    title: 'Offer Letter',
    variables: ['candidate_name', 'designation', 'department', 'ctc', 'joining_date', 'probation_period', 'reporting_manager', 'location', 'company_name', 'reference_no'],
    html_content: `<!DOCTYPE html>
<html>
<head><style>
@page { margin: 20mm 15mm; }
body { font-family: 'Times New Roman', Times, serif; margin: 0; padding: 40px; color: #2d2d2d; font-size: 14px; line-height: 1.6; }

/* Letterhead */
.letterhead { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px double #1a3a5c; padding-bottom: 20px; margin-bottom: 25px; }
.letterhead .logo { width: 80px; height: 80px; background: #f0f4f8; border: 1px dashed #1a3a5c; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #1a3a5c; text-align: center; }
.letterhead .company-info { text-align: right; }
.letterhead .company-info h1 { margin: 0; font-size: 22px; color: #1a3a5c; letter-spacing: 1px; text-transform: uppercase; }
.letterhead .company-info p { margin: 2px 0; font-size: 12px; color: #555; }

/* Reference & Date Row */
.ref-row { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; color: #444; }
.ref-row .ref span { font-weight: bold; color: #1a3a5c; }

/* Subject */
.subject-box { margin-bottom: 20px; }
.subject-box .subject-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 2px; }
.subject-box .subject-text { font-weight: bold; font-size: 16px; color: #1a3a5c; text-decoration: underline; }

/* Salutation */
.salutation { margin-bottom: 15px; }

/* Body */
.body-text p { margin-bottom: 12px; text-align: justify; }

/* Info Table */
.info-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
.info-table td { padding: 8px 12px; border-bottom: 1px solid #e0e0e0; font-size: 14px; }
.info-table td:first-child { width: 180px; font-weight: bold; color: #1a3a5c; background: #f8fafc; }

/* Terms Section */
.terms-section { margin: 20px 0; border: 1px solid #1a3a5c; border-radius: 4px; padding: 0; }
.terms-section .terms-header { background: #1a3a5c; color: #fff; padding: 10px 15px; font-weight: bold; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
.terms-section .terms-body { padding: 15px; }
.terms-section .terms-body ol { margin: 0; padding-left: 20px; }
.terms-section .terms-body ol li { margin-bottom: 8px; text-align: justify; font-size: 13px; line-height: 1.5; }

/* Declaration */
.declaration { margin: 20px 0; padding: 15px; background: #f9fafb; border-left: 4px solid #1a3a5c; font-style: italic; font-size: 13px; color: #555; }

/* Signature Block */
.signature-section { margin-top: 40px; display: flex; justify-content: space-between; gap: 40px; }
.signature-block { flex: 1; }
.signature-block .sig-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
.signature-block .sig-line { border-top: 1px solid #333; width: 250px; margin-bottom: 5px; }
.signature-block .sig-name { font-weight: bold; color: #1a3a5c; }
.signature-block .sig-title { font-size: 12px; color: #666; }

/* Stamp Placeholder */
.stamp { margin-top: 10px; width: 100px; height: 100px; border: 2px dashed #1a3a5c; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #1a3a5c; text-align: center; text-transform: uppercase; letter-spacing: 1px; }

/* Footer */
.footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #ccc; font-size: 11px; color: #999; text-align: center; line-height: 1.4; }
.footer strong { color: #666; }

/* Print */
@media print { body { padding: 0; } .no-print { display: none; } }
</style></head>
<body>

<!-- Letterhead -->
<div class="letterhead">
  <div class="logo">[LOGO]</div>
  <div class="company-info">
    <h1>{company_name}</h1>
    <p>Registered Office: {location}</p>
  </div>
</div>

<!-- Reference & Date -->
<div class="ref-row">
  <div class="ref"><span>Ref No:</span> {reference_no}</div>
  <div class="ref"><span>Date:</span> {joining_date}</div>
</div>

<!-- Subject -->
<div class="subject-box">
  <div class="subject-label">Subject</div>
  <div class="subject-text">Appointment as {designation}</div>
</div>

<!-- Salutation -->
<div class="salutation">
  <p>Dear <strong>{candidate_name}</strong>,</p>
</div>

<!-- Body -->
<div class="body-text">
  <p>We are pleased to inform you that based on your application and subsequent interviews, you have been selected for the position of <strong>{designation}</strong> in the <strong>{department}</strong> department at <strong>{company_name}</strong>. We are delighted to offer you this appointment and look forward to having you as part of our growing team.</p>
</div>

<!-- Appointment Details Table -->
<table class="info-table">
  <tr><td>Position</td><td>{designation}</td></tr>
  <tr><td>Department</td><td>{department}</td></tr>
  <tr><td>Date of Joining</td><td>{joining_date}</td></tr>
  <tr><td>Reporting Manager</td><td>{reporting_manager}</td></tr>
  <tr><td>Location</td><td>{location}</td></tr>
  <tr><td>Probation Period</td><td>{probation_period}</td></tr>
  <tr><td>Annual CTC (Cost to Company)</td><td><strong>₹{ctc}</strong></td></tr>
</table>

<!-- Body continued -->
<div class="body-text">
  <p>Your compensation package includes basic salary, house rent allowance, conveyance allowance, medical allowance, special allowance, and other perquisites as per company policy. Detailed terms of employment are outlined in your employment contract, which will be shared separately.</p>
  <p>You will be on a probation period of <strong>{probation_period}</strong> from the date of joining, during which your performance will be evaluated. Upon successful completion of probation, your employment will be confirmed on a permanent basis subject to the terms and conditions of the company.</p>
</div>

<!-- Terms & Conditions -->
<div class="terms-section">
  <div class="terms-header">Terms &amp; Conditions</div>
  <div class="terms-body">
    <ol>
      <li>Your employment is subject to the successful verification of your educational certificates, previous employment details, and background checks.</li>
      <li>You shall abide by all rules, regulations, and policies of the company as amended from time to time.</li>
      <li>During your employment, you shall devote your full time and attention to the business of the company and shall not engage in any other employment or business activity without prior written consent.</li>
      <li>You shall maintain strict confidentiality of all proprietary information, trade secrets, and business affairs of the company during and after your employment.</li>
      <li>The company reserves the right to terminate your employment during the probation period with a notice period of one week, or after confirmation with one month's notice as per company policy.</li>
      <li>Any intellectual property created by you during the course of employment shall be the sole property of the company.</li>
      <li>You shall be entitled to leave, medical benefits, and other benefits as per the company's HR policy in effect from time to time.</li>
    </ol>
  </div>
</div>

<!-- Declaration -->
<div class="declaration">
  I confirm that I have read, understood, and accept the terms and conditions of this appointment letter and agree to abide by the policies of {company_name}.
</div>

<!-- Signatures -->
<div class="signature-section">
  <div class="signature-block">
    <div class="sig-label">For {company_name}</div>
    <div style="height: 50px;"></div>
    <div class="sig-line"></div>
    <div class="sig-name">Authorised Signatory</div>
    <div class="sig-title">HR Department, {company_name}</div>
    <div class="stamp">[COMPANY<br>SEAL]</div>
  </div>
  <div class="signature-block" style="text-align: right;">
    <div class="sig-label">Accepted By</div>
    <div style="height: 50px;"></div>
    <div class="sig-line" style="margin-left: auto;"></div>
    <div class="sig-name">{candidate_name}</div>
    <div class="sig-title">{designation}</div>
    <div style="margin-top: 10px; font-size: 12px; color: #666;">
      <div>Date: _______________</div>
      <div style="margin-top: 5px;">Signature: _______________</div>
    </div>
  </div>
</div>

<!-- Footer -->
<div class="footer">
  <strong>{company_name}</strong> &mdash; This is a computer-generated document issued by the HR Department.<br>
  Registered Address: {location} &mdash; Email: hr@{company_name}.com
</div>

</body>
</html>`,
  },
  {
    category: 'experience',
    title: 'Experience Letter',
    variables: ['employee_name', 'designation', 'department', 'tenure', 'from_date', 'to_date', 'company_name'],
    html_content: `<!DOCTYPE html>
<html>
<head><style>
body { font-family: 'Inter', Arial, sans-serif; margin: 40px; color: #333; }
.header { text-align: center; margin-bottom: 30px; }
.header h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
.date { text-align: right; margin-bottom: 20px; color: #666; }
.subject { font-weight: bold; margin-bottom: 20px; }
.content p { line-height: 1.8; margin-bottom: 12px; }
.signature { margin-top: 40px; }
.footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
<div class="header">
  <h1>{company_name}</h1>
  <h2>Experience Certificate</h2>
</div>
<div class="date">Date: {to_date}</div>
<div class="subject">Subject: Certificate of Experience</div>
<div class="content">
  <p>This is to certify that <strong>{employee_name}</strong> has worked with {company_name} as <strong>{designation}</strong> in the <strong>{department}</strong> department.</p>
  <p>Their tenure with us was from <strong>{from_date}</strong> to <strong>{to_date}</strong>, a period of <strong>{tenure}</strong>.</p>
  <p>During their tenure, they demonstrated dedication, professionalism, and valuable contributions to the team.</p>
  <p>We wish them all the best in their future endeavors.</p>
</div>
<div class="signature">
  <p>Yours faithfully,</p>
  <p><strong>HR Department</strong></p>
  <p>{company_name}</p>
</div>
<div class="footer">
  <p>This is a computer-generated document.</p>
</div>
</body>
</html>`,
  },
  {
    category: 'appointment',
    title: 'Appointment Letter',
    variables: ['employee_name', 'designation', 'department', 'effective_date', 'terms', 'company_name'],
    html_content: `<!DOCTYPE html>
<html>
<head><style>
body { font-family: 'Inter', Arial, sans-serif; margin: 40px; color: #333; }
.header { text-align: center; margin-bottom: 30px; }
.header h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
.date { text-align: right; margin-bottom: 20px; color: #666; }
.subject { font-weight: bold; margin-bottom: 20px; }
.content p { line-height: 1.8; margin-bottom: 12px; }
.terms { background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 20px 0; }
.terms p { margin: 5px 0; }
.signature { margin-top: 40px; }
.footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
<div class="header">
  <h1>{company_name}</h1>
  <h2>Appointment Letter</h2>
</div>
<div class="date">Date: {effective_date}</div>
<div class="subject">Subject: Appointment as {designation}</div>
<div class="content">
  <p>Dear {employee_name},</p>
  <p>We are pleased to appoint you as <strong>{designation}</strong> in the <strong>{department}</strong> department at {company_name}, effective <strong>{effective_date}</strong>.</p>
  <div class="terms">
    <p><strong>Terms & Conditions:</strong></p>
    <p>{terms}</p>
  </div>
  <p>You will be governed by the company's rules and regulations as applicable from time to time.</p>
  <p>We welcome you to the organization and look forward to a long and mutually beneficial association.</p>
</div>
<div class="signature">
  <p>Yours sincerely,</p>
  <p><strong>HR Department</strong></p>
  <p>{company_name}</p>
</div>
<div class="footer">
  <p>This is a computer-generated document.</p>
</div>
</body>
</html>`,
  },
  {
    category: 'salary_revision',
    title: 'Salary Revision Letter',
    variables: ['employee_name', 'designation', 'old_ctc', 'new_ctc', 'effective_date', 'company_name'],
    html_content: `<!DOCTYPE html>
<html>
<head><style>
body { font-family: 'Inter', Arial, sans-serif; margin: 40px; color: #333; }
.header { text-align: center; margin-bottom: 30px; }
.header h1 { color: #1a1a2e; margin: 0; font-size: 24px; }
.date { text-align: right; margin-bottom: 20px; color: #666; }
.subject { font-weight: bold; margin-bottom: 20px; }
.content p { line-height: 1.8; margin-bottom: 12px; }
.highlight { background: #fefce8; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #eab308; }
.highlight p { margin: 5px 0; }
.signature { margin-top: 40px; }
.footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
<div class="header">
  <h1>{company_name}</h1>
  <h2>Salary Revision Letter</h2>
</div>
<div class="date">Date: {effective_date}</div>
<div class="subject">Subject: Salary Revision</div>
<div class="content">
  <p>Dear {employee_name},</p>
  <p>We are pleased to inform you that based on your performance and contributions, your compensation has been revised.</p>
  <div class="highlight">
    <p><strong>Current CTC:</strong> ₹{old_ctc} per annum</p>
    <p><strong>Revised CTC:</strong> ₹{new_ctc} per annum</p>
    <p><strong>Effective Date:</strong> {effective_date}</p>
  </div>
  <p>This revision reflects our appreciation for your continued dedication and hard work as <strong>{designation}</strong>.</p>
  <p>We look forward to your continued contributions to the growth of {company_name}.</p>
</div>
<div class="signature">
  <p>Yours sincerely,</p>
  <p><strong>Management</strong></p>
  <p>{company_name}</p>
</div>
<div class="footer">
  <p>This is a computer-generated document.</p>
</div>
</body>
</html>`,
  },
];

export const seedTemplates = async (req, res) => {
  try {
    const ngo_id = req.body.ngo_id || req.user.ngo_id;
    if (!ngo_id) return res.status(400).json({ message: 'ngo_id is required' });

    const existing = await getAllTemplates(ngo_id);
    if (existing.length > 0) {
      return res.json({ message: 'Templates already exist for this NGO', count: existing.length });
    }

    const created = [];
    for (const tpl of SAMPLE_TEMPLATES) {
      const template = await createTemplate({
        ngo_id,
        title: tpl.title,
        category: tpl.category,
        html_content: tpl.html_content,
        variables: tpl.variables,
        created_by: req.user.id,
      });
      created.push(template);
    }
    return res.status(201).json({ message: `${created.length} templates seeded successfully`, templates: created });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listTemplates = async (req, res) => {
  try {
    const ngo_id = req.query.ngo_id || req.user.ngo_id;
    const templates = await getAllTemplates(ngo_id);
    return res.json(templates);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTemplate = async (req, res) => {
  try {
    const template = await getTemplateById(req.params.id);
    if (!template) return res.status(404).json({ message: 'Template not found' });
    return res.json(template);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addTemplate = async (req, res) => {
  try {
    const ngo_id = req.body.ngo_id || req.user.ngo_id;
    const { title, category, html_content, variables } = req.body;
    if (!ngo_id || !title || !category || !html_content) {
      return res.status(400).json({ message: 'ngo_id, title, category, and html_content are required' });
    }
    const template = await createTemplate({ ngo_id, title, category, html_content, variables: variables || [], created_by: req.user.id });
    return res.status(201).json({ message: 'Template created successfully', template });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editTemplate = async (req, res) => {
  try {
    const { title, category, html_content, variables, is_active } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (category) updates.category = category;
    if (html_content) updates.html_content = html_content;
    if (variables) updates.variables = variables;
    if (is_active !== undefined) updates.is_active = is_active;
    const template = await updateTemplate(req.params.id, updates);
    return res.json({ message: 'Template updated successfully', template });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeTemplate = async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const generateLetter = async (req, res) => {
  try {
    const ngo_id = req.body.ngo_id || req.user.ngo_id;
    const { template_id, worker_id } = req.body;
    if (!template_id || !worker_id || !ngo_id) {
      return res.status(400).json({ message: 'template_id, worker_id, and ngo_id are required' });
    }

    const template = await getTemplateById(template_id);
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const worker = await getWorkerById(worker_id);
    if (!worker) return res.status(404).json({ message: 'Worker not found' });

    let filledHtml = template.html_content;
    const vars = req.body.variables || {};
    template.variables.forEach((v) => {
      let val = vars[v];
      if (!val) {
        const stripped = v.replace(/^(employee_|candidate_|emp_)/, '');
        val = worker[stripped] || worker[v] || `[${v}]`;
      }
      filledHtml = filledHtml.replaceAll(`{${v}}`, val);
    });

    const letter = await createGeneratedLetter({
      template_id,
      worker_id,
      ngo_id,
      generated_by: req.user.id,
      filled_html: filledHtml,
      variables: vars,
    });

    return res.status(201).json({ message: 'Letter generated successfully', letter });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listGeneratedLetters = async (req, res) => {
  try {
    const ngo_id = req.query.ngo_id || req.user.ngo_id;
    const letters = await getGeneratedLetters(ngo_id);
    return res.json(letters);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkerLetters = async (req, res) => {
  try {
    const { workerId } = req.params;
    const letters = await getGeneratedLettersByWorkerId(workerId);
    return res.json(letters);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const downloadLetter = async (req, res) => {
  try {
    const { id } = req.params;
    const letter = await getGeneratedLetterById(id);
    if (!letter) return res.status(404).json({ message: 'Letter not found' });

    const workerName = letter.worker?.name || 'employee';
    const templateTitle = letter.template?.title || 'letter';
    const filename = `${workerName.replace(/\s+/g, '_')}_${templateTitle.replace(/\s+/g, '_')}.html`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(letter.filled_html);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
