-- 111: Replace all reminder data with the updated dataset.
-- This removes old seed data and inserts the full updated set.
-- Safe to re-run (uses ON CONFLICT DO NOTHING).

DELETE FROM reminders;

INSERT INTO reminders
  (title, category, owner, due_date_display, renewal_date_display, display_frequency, notes, status)
VALUES
  -- Property Maintenance
  ('Sanjar Flat No. 506', 'PROPERTY_MAINTENANCE', 'Priyank Shah', '15th of Every 3 Months', '15th April, 2026', '15th of Every 3 Months', 'Rs. 133592', 'Upcoming'),
  ('Sanjar One World Office No. 1708', 'PROPERTY_MAINTENANCE', 'Priyank Shah', NULL, NULL, NULL, NULL, 'Upcoming'),
  ('Login Flat No. 205', 'PROPERTY_MAINTENANCE', 'Priyank Shah', NULL, NULL, NULL, '7.9.2026 | Rs. 35381', 'Upcoming'),
  ('Auris Office No. 218', 'PROPERTY_MAINTENANCE', 'Shweta Shah', '1.6.2026', '30.11.2026', NULL, '10.8.2026 | Rs. 119069', 'Upcoming'),
  ('New Delight (Flat No. 401) 2 Months Bill Pattern', 'PROPERTY_MAINTENANCE', 'Priyank Shah', '5th of Every Alternate month', '5th of Every Alternate month', '5th of Every Alternate month', '31.8.2026 | Rs. 4144', 'Upcoming'),

  -- Property BMC Tax
  ('Sanjar Office No. 506 Account No. RS0200240020030', 'BMC_TAX', 'Priyank Shah', NULL, NULL, NULL, '7.9.2026 | Rs. 55880', 'Upcoming'),
  ('Auris', 'BMC_TAX', 'Shweta Shah', NULL, NULL, NULL, NULL, 'Upcoming'),
  ('Login Flat No. 205 Account No. RS0406272780009', 'BMC_TAX', 'Priyank Shah', NULL, NULL, NULL, '7.9.2026 | Rs. 4884', 'Upcoming'),
  ('Sanjar One World Office No. 1708 Account No. PN0906610310169', 'BMC_TAX', 'Priyank Shah', '1st April, 2025 till date pending', 'Every 6 Months', 'Every 6 Months', '7.9.2026 | Rs. 47608', 'Upcoming'),
  ('New Delight (Flat No. 401)', 'BMC_TAX', 'Priyank Shah', NULL, NULL, NULL, NULL, 'Upcoming'),

  -- Home and Office Rent
  ('Ashray Rent (Manish Anil Dattani)', 'RENT_TDS', 'AFLF', '5th of Every Month', 'NA', 'Every Month', '7.9.26 | Rs. 73000', 'Upcoming'),
  ('Ashray Rent (Manish Anil Dattani) TDS', 'RENT_TDS', 'AFLF', 'March of Every Year', 'NA', 'Every Year', NULL, 'Upcoming'),
  ('BSCT Rent (Chiraag Anil Dattani)', 'RENT_TDS', 'BSCT', '5th of Every Month', 'NA', 'Every Month', '7.9.26 | Rs. 80000', 'Upcoming'),
  ('BSCT Rent (Chiraag Anil Dattani) TDS', 'RENT_TDS', 'BSCT', 'March of Every Year', 'NA', 'Every Year', NULL, 'Upcoming'),
  ('MANN Rent (Bijal Anil Dattani)', 'RENT_TDS', 'MANN', '5th of Every Month', 'NA', 'Every Month', '7.9.26 | Rs. 47000', 'Upcoming'),
  ('MANN Rent (Bijal Anil Dattani) TDS', 'RENT_TDS', 'MANN', 'March of Every Year', 'NA', 'Every Year', NULL, 'Upcoming'),
  ('Raj Cresent (Priyank Sir)', 'RENT_TDS', 'Priyank Shah', '3rd every month', '3rd every month', 'Every Month', '7.9.2026 | Rs. 34740', 'Upcoming'),

  -- Insurance
  ('Priyank Sir LIC Policy No. 1 (905633591) (8.8.2007) Premium Rs. 3250', 'INSURANCE', 'Priyank Shah', '1st Aug every year', '1st Aug, 2026', 'Every Year', '26.8.26 | Rs. 3250', 'Upcoming'),
  ('Priyank Sir LIC Policy No. 2 (905936640) (14.8.2008) Premium Rs. 16,222/-', 'INSURANCE', 'Priyank Shah', '1st Aug every year', '1st Aug, 2026', 'Every Year', '26.8.26 | Rs. 16222', 'Upcoming'),
  ('The New India Assurance Co. Ltd. Priyank Sir Mediclaim Policy No. 11250061259500000906 Customer ID No. H4412309 Rs. 18,699/-', 'INSURANCE', 'Priyank Shah', '25th June every Year', '25th June, 2026', 'Every Year', '22.6.2026 | Rs. 18699', 'Upcoming'),
  ('Aditya Birla Capital (Health Insurance Shweta Madam and Priyansh) Premium Rs. 9,617/- Policy No. 23-18-0048782-04', 'INSURANCE', 'Shweta Shah', '1st Dec every year', '1st Dec, 2026', 'Every Year', NULL, 'Upcoming'),
  ('Tata AIG Life Insurance Term Plan (Priyank Sir) Premium Rs. 9,794/- (Policy No. C-301269757)', 'INSURANCE', 'Priyank Shah', '1st Dec every year', '1st Dec, 2026', 'Every Year', NULL, 'Upcoming'),

  -- Education
  ('Priyansh Policy No. (007493022 Rs. 50K) of Education (Aditya Birla Capital)', 'EDUCATION', 'Shweta Shah', '1st Feb every year', '1st Feb every year', 'Every Year', NULL, 'Upcoming'),
  ('Priyansh Policy No. (007493097 Rs. 50K) of Education (Aditya Birla Capital)', 'EDUCATION', 'Shweta Shah', '1st Feb every year', '1st Feb every year', 'Every Year', NULL, 'Upcoming'),
  ('Priyansh School Expenses', 'EDUCATION', 'Shweta Shah', NULL, NULL, NULL, NULL, 'Upcoming'),

  -- Website Domain Renewal
  ('Ultimate (Sagar Jain)', 'WEBSITE_DOMAIN', 'Priyank Shah', '1st Sept of every year', 'Renew 1st Sept, 2026', 'Every Year', NULL, 'Upcoming'),
  ('BSCT (Firefly Solution)', 'WEBSITE_DOMAIN', 'BSCT', NULL, NULL, NULL, NULL, 'Upcoming'),
  ('AFLF (Sagar Jain)', 'WEBSITE_DOMAIN', 'AFLF', '1st Aug of every year', 'Renew 1st Aug, 2026', 'Every Year', NULL, 'Upcoming'),

  -- Vehicle Insurance
  ('MG Hector 9999 Future Generally Car Insurance Premium Rs. 17,274/-', 'VEHICLE_INSURANCE', 'Priyank Shah', '25th May of Every Year', '25th May, 2027', 'Every Year', NULL, 'Upcoming'),
  ('MG Hector 9999 PUC Vehicle No. MH13EK9999', 'VEHICLE_INSURANCE', 'Priyank Shah', '7th Feb, 2024', '27th Aug, 2027', NULL, NULL, 'Upcoming'),
  ('Yamaha Bike Insurance MH-47BQ7655 TATA AIG Gen. Insurance Policy No. 61006197690000 Valid Upto 4th Dec, 2028', 'VEHICLE_INSURANCE', 'Shweta Shah', '4th Dec, 2028', '1st Dec, 2028', NULL, NULL, 'Upcoming'),
  ('Yamaha Bike PUC', 'VEHICLE_INSURANCE', 'Shweta Shah', '29th Jan, 2026', '30th Jan, 2026', NULL, NULL, 'Upcoming'),
  ('Honda White Activa MH-02 CM-9337 Engine No. JC44E5148617 Policy No. D-182640541/ 13012025', 'VEHICLE_INSURANCE', 'Shweta Shah', '13th Jan, 2027', '1st Jan, 2027', NULL, NULL, 'Upcoming'),
  ('Honda White Activa PUC', 'VEHICLE_INSURANCE', 'Shweta Shah', NULL, NULL, NULL, NULL, 'Upcoming'),

  -- Electricity
  ('Raj Cresent A-101', 'ELECTRICITY', 'Priyank Shah', '5th of Every Month', '5th of Every Month', 'Every Month', NULL, 'Upcoming'),
  ('New Delight Office No. 401', 'ELECTRICITY', 'Priyank Shah', '5th of Every Month', NULL, 'Every Month', '4.9.2026 | Rs. 2240', 'Upcoming'),
  ('AFLF Electricity (Account No. 150287186)', 'ELECTRICITY', 'AFLF', '5th of Every Month', 'NA', 'Every Month', '7.9.2026 | Rs. 11950', 'Upcoming'),
  ('BSCT Electricity (Account No. 100204881)', 'ELECTRICITY', 'BSCT', '5th of Every Month', 'NA', 'Every Month', '7.9.2026 | Rs. 13460', 'Upcoming'),
  ('Login Flat No. 205 (Bill No. 900001175100 Tata Power)', 'ELECTRICITY', 'Priyank Shah', 'Paid by Tenant', 'Paid by Tenant', NULL, NULL, 'Upcoming'),
  ('Sanjar Office No. 506', 'ELECTRICITY', 'Priyank Shah', 'Paid by Tenant', 'Paid by Tenant', NULL, NULL, 'Upcoming'),
  ('Sanjar One World (Adani Elec. 153792870)', 'ELECTRICITY', 'Priyank Shah', '15th of Every Month', 'Paid by Tenant', 'Every Month', NULL, 'Upcoming'),
  ('Auris office no. 218 (Invoice) Adani Electricity Bill No. 153900402', 'ELECTRICITY', 'Shweta Shah', 'Paid by Tenant', 'Paid by Tenant', NULL, NULL, 'Upcoming'),

  -- Other Bills
  ('Wondershare Glo', 'OTHER_BILL', 'Priyank Shah', '9th of Every Month', '9th of Every Month', 'Every Month', NULL, 'Upcoming'),

  -- VI Bill Account No. 118978300
  ('9892990029 Primary Vi Max Family 1401', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300', 'Upcoming'),
  ('9987344338 Secondary', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300', 'Upcoming'),
  ('9967699295 Secondary', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300', 'Upcoming'),
  ('9892268000 Secondary', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300', 'Upcoming'),
  ('9930028300 Secondary', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300', 'Upcoming'),
  ('7039006200 Secondary', 'VI_BILL', 'Suraj Patil', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300 | Locker', 'Upcoming'),
  ('7039006300 Secondary', 'VI_BILL', 'Anjana Vyas', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300 | Locker', 'Upcoming'),
  ('7039006400 Secondary', 'VI_BILL', 'Anjana Vyas', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 118978300 | Locker', 'Upcoming'),

  -- VI Bill Account No. 107587212
  ('8879035035 Primary Vi Max Family 1201', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212', 'Upcoming'),
  ('8879034034 Secondary', 'VI_BILL', 'Priyank Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212', 'Upcoming'),
  ('9930028200 Secondary', 'VI_BILL', 'Shweta Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212', 'Upcoming'),
  ('9930028400 Secondary', 'VI_BILL', 'Shweta Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212', 'Upcoming'),
  ('9930064928 Secondary', 'VI_BILL', 'Suraj Patil', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212 | Locker', 'Upcoming'),
  ('9930084397 Secondary', 'VI_BILL', 'Suraj Patil', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 107587212 | Locker', 'Upcoming'),

  -- VI Bill Account No. 176955124
  ('9820646225 Primary Vi Max Family 1201', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 176955124', 'Upcoming'),
  ('9820644749 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 176955124', 'Upcoming'),
  ('9820645607 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 176955124', 'Upcoming'),
  ('9820641314 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 176955124 | Locker', 'Upcoming'),
  ('9820648405 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 176955124 | Locker', 'Upcoming'),

  -- VI Bill Account No. 177089161
  ('8879136938 Primary Vi Max Family 1401', 'VI_BILL', 'Shweta Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 177089161', 'Upcoming'),
  ('8879136654 Secondary', 'VI_BILL', 'Shweta Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 177089161', 'Upcoming'),
  ('8879136934 Secondary', 'VI_BILL', 'Shweta Shah', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 177089161', 'Upcoming'),
  ('9920893993 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 177089161', 'Upcoming'),
  ('9930852952 Secondary', 'VI_BILL', 'Naresh Bhanushali', '1st of Every Month', '1st of Every Month', 'Every Month', 'VI Account 177089161 | Locker', 'Upcoming');
