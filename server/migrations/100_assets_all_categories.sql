-- 100: Seed the full Office Asset Register (all categories, idempotent)
-- Machines (Desktop/Laptop) dedupe by code; quantity lines dedupe by category + name + location.
-- Also clears any empty-string codes so quantity rows satisfy the UNIQUE index on (code).

BEGIN;

UPDATE assets SET code = NULL WHERE code = '';

-- Machines (Desktop/Laptop)
INSERT INTO assets (code, name, category, location, quantity, team_leader, remarks, status) VALUES
  ('DESK-1 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-2 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-3 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-4 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-5 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-6 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-7 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-8 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-9 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-10 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-11 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-12 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-13 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-14 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-15 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-16 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-17 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-18 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-19 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-20 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-21 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-22 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-23 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-24 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-25 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-26 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-27 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-28 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-29 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-30 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-31 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('DESK-32 (AFLF)', 'Desktop', 'Desktop', 'AFLF Cabin', 1, 'Anjana Vyas', 'FRO Department', 'available'),
  ('LAP-1 (Admin)', 'Laptop', 'Laptop', 'AFLF Cabin', 1, 'Anjana Vyas', 'NGO Admin', 'available'),
  ('DESK-1 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Ganesh Salkar', 'Social Media Department', 'available'),
  ('DESK-2 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Ganesh Salkar', 'Social Media Department', 'available'),
  ('DESK-3 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Ganesh Salkar', 'Social Media Department', 'available'),
  ('DESK-4 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Ganesh Salkar', 'Social Media Department', 'available'),
  ('DESK-5 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Ganesh Salkar', 'Social Media Department', 'available'),
  ('DESK-1 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Vaishali Sawant', 'Accounts  Department', 'available'),
  ('DESK-2 (MANN)', 'Desktop', 'Desktop', 'MANN Cabin', 1, 'Vaishali Sawant', 'Accounts  Department', 'available'),
  ('DESK-1 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-2 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-3 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-4 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-5 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-6 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-7 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-8 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-9 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-10 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-11 (BPO)', 'Desktop', 'Desktop', 'BPO Cabin', 1, 'Sonali Wankhede', 'FRO Department', 'available'),
  ('DESK-1 (REPT)', 'Desktop', 'Desktop', 'Reception Cabin', 1, 'Deepak Karkera', 'HR Department', 'available'),
  ('DESK-2 (REPT)', 'Desktop', 'Desktop', 'Reception Cabin', 1, 'Deepak Karkera', 'HR Department', 'available'),
  ('LAP-1 (MANN)', 'Laptop', 'Laptop', 'MANN Cabin', 1, 'Shital Parmar', 'Social Media Department', 'available'),
  ('LAP-2 (MANN)', 'Laptop', 'Laptop', 'MANN Cabin', 1, 'Shital Parmar', 'Social Media Department', 'available'),
  ('LAP-3 (MANN)', 'Laptop', 'Laptop', 'MANN Cabin', 1, 'Shital Parmar', 'Social Media Department', 'available'),
  ('LAP-4 (MANN)', 'Laptop', 'Laptop', 'MANN Cabin', 1, 'Shital Parmar', 'Social Media Department', 'available'),
  ('LAP-5 (MANN)', 'Laptop', 'Laptop', 'MANN Cabin', 1, 'Shital Parmar', 'Social Media Department', 'available'),
  ('LAP-1 (REPT)', 'Desktop', 'Desktop', 'Reception Cabin', 1, 'Deepak Karkera', 'HR Department', 'available'),
  ('LAP-2 (REPT)', 'Desktop', 'Desktop', 'Reception Cabin', 1, 'Deepak Karkera', 'HR Department', 'available'),
  ('LAP-3 (REPT)', 'Desktop', 'Desktop', 'Reception Cabin', 1, 'Deepak Karkera', 'HR Department', 'available'),
  ('LAP-1 (SIR)', 'Laptop', 'Laptop', 'Director''s Cabin', 1, 'Priyank Sir', 'Super Admin', 'available')
ON CONFLICT (code) DO NOTHING;

-- Quantity lines (all non-Desktop/Laptop categories)
INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Lights', 'Ceiling Lights', 'Balcony', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Ceiling Lights' AND a.location = 'Balcony');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Ceiling Fan', 'Balcony', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Fan' AND a.name = 'Ceiling Fan' AND a.location = 'Balcony');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Cameras', 'Cameras', 'Balcony', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Cameras' AND a.location = 'Balcony');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Sofa', 'Furniture', 'Balcony', 1, 'Office Sofa', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Office Sofa' AND a.location = 'Balcony');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Window A.C.', 'Air Conditioner', 'AFLF Cabin', 1, 'Window A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Window A.C.' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Window A.C.', 'Air Conditioner', 'AFLF Cabin', 1, 'Window A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Window A.C.' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Lights', 'Ceiling Lights', 'AFLF Cabin', 16, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Ceiling Lights' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Ceiling Fan', 'AFLF Cabin', 6, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Fan' AND a.name = 'Ceiling Fan' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Cameras', 'Cameras', 'AFLF Cabin', 4, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Cameras' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Kitchen Light', 'Ceiling Lights', 'AFLF Cabin', 1, 'Kitchen Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Kitchen Light' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Washroom Light', 'Ceiling Lights', 'AFLF Cabin', 1, 'Washroom Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Washroom Light' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Washroom Exhaus Fan', 'Exhaust Fan', 'AFLF Cabin', 1, 'Washroom Exhaus Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Exhaust Fan' AND a.name = 'Washroom Exhaus Fan' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'AFLF Cabin', 32, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wooden Chair', 'Office Chair', 'AFLF Cabin', 1, 'Wooden Chair', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Wooden Chair' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Sofa', 'Furniture', 'AFLF Cabin', 1, 'Office Sofa', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Office Sofa' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Android Mobile', 'Android Mobile', 'AFLF Cabin', 39, 'Android Mobile', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Android Mobile' AND a.name = 'Android Mobile' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Nokia Mobile', 'Nokia Mobile', 'AFLF Cabin', 41, 'Nokia Mobile', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Nokia Mobile' AND a.name = 'Nokia Mobile' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Passage Light', 'Ceiling Lights', 'AFLF Cabin', 1, 'Passage Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Passage Light' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Passage Camera', 'Cameras', 'AFLF Cabin', 1, 'Passage Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Passage Camera' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Water Tank', 'Water Tank', 'AFLF Cabin', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Water Tank' AND a.name = 'Water Tank' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Writing Board', 'Office Equipment', 'AFLF Cabin', 3, 'Writing Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Writing Board' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Water Dispenser', 'Office Equipment', 'AFLF Cabin', 1, 'Water Dispenser', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Water Dispenser' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Server Rack', 'Office Equipment', 'AFLF Cabin', 1, 'Server Rack', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Server Rack' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT '24 (1 Piece), 16 (2 Piece)', 'Networking Switch', 'AFLF Cabin', 3, '24 (1 Piece), 16 (2 Piece)', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Networking Switch' AND a.name = '24 (1 Piece), 16 (2 Piece)' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wooden Storage Cupboard', 'Furniture', 'AFLF Cabin', 1, 'Wooden Storage Cupboard', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Wooden Storage Cupboard' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'AFLF Cabin', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'AFLF Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Mann Cabin', 'Ceiling Lights', 'MANN Cabin', 6, 'Mann Cabin', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Mann Cabin' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Ceiling Fan', 'MANN Cabin', 3, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Fan' AND a.name = 'Ceiling Fan' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Camera', 'Cameras', 'MANN Cabin', 2, 'Wall Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Wall Camera' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Social Media Department', 'Server Desktop', 'MANN Cabin', 1, 'Social Media Department', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Server Desktop' AND a.name = 'Social Media Department' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Admin Department', 'Android Mobile', 'MANN Cabin', 3, 'Admin Department', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Android Mobile' AND a.name = 'Admin Department' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Admin Department', 'External Hard Drive 2GB', 'MANN Cabin', 1, 'Admin Department', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'External Hard Drive 2GB' AND a.name = 'Admin Department' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Social Media Department (I Phone and AFLF)', 'Android Mobile', 'MANN Cabin', 2, 'Social Media Department (I Phone and AFLF)', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Android Mobile' AND a.name = 'Social Media Department (I Phone and AFLF)' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Social Media', 'External Hard Drive 5GB', 'MANN Cabin', 1, 'Social Media', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'External Hard Drive 5GB' AND a.name = 'Social Media' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'MANN Cabin', 13, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Plastic Chair', 'Office Chair', 'MANN Cabin', 2, 'Plastic Chair', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Plastic Chair' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'MANN Cabin', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'DSLR Camera', 'Shooting Accessories', 'MANN Cabin', 1, 'DSLR Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'DSLR Camera' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Flash', 'Shooting Accessories', 'MANN Cabin', 1, 'Flash', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Flash' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera Battery', 'Shooting Accessories', 'MANN Cabin', 2, 'Camera Battery', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Camera Battery' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Charger', 'Shooting Accessories', 'MANN Cabin', 1, 'Charger', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Charger' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Flash Battery with Charger', 'Shooting Accessories', 'MANN Cabin', 2, 'Flash Battery with Charger', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Flash Battery with Charger' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Phone Power Bank', 'Shooting Accessories', 'MANN Cabin', 1, 'Phone Power Bank', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Phone Power Bank' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera Cleaning Tool Kit', 'Shooting Accessories', 'MANN Cabin', 1, 'Camera Cleaning Tool Kit', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Camera Cleaning Tool Kit' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Card Reader', 'Shooting Accessories', 'MANN Cabin', 1, 'Card Reader', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Card Reader' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Tripot', 'Shooting Accessories', 'MANN Cabin', 1, 'Tripot', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Shooting Accessories' AND a.name = 'Tripot' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Photo Frame', 'Office Equipment', 'MANN Cabin', 12, 'Wall Photo Frame', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wall Photo Frame' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Metal Cupboard', 'Furniture', 'MANN Cabin', 1, 'Metal Cupboard', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Metal Cupboard' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Laptop Bags', 'Office Equipment', 'MANN Cabin', 5, 'Laptop Bags', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Laptop Bags' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Split A.C.', 'Air Conditioner', 'MANN Cabin', 1, 'Split A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Split A.C.' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Printer', 'Office Equipment', 'MANN Cabin', 1, 'Printer', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Printer' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Writing Board', 'Office Equipment', 'MANN Cabin', 2, 'Writing Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Writing Board' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'MANN Cabin', 6, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Washroom', 'Ceiling Lights', 'MANN Cabin', 4, 'Washroom', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Washroom' AND a.location = 'MANN Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'BPO Cabin', 4, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'BPO Cabin', 2, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Window A.C.', 'Air Conditioner', 'BPO Cabin', 1, 'Window A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Window A.C.' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'BPO Cabin', 12, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Cameras', 'Cameras', 'BPO Cabin', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Cameras' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Writing Board', 'Office Equipment', 'BPO Cabin', 1, 'Writing Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Writing Board' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'BPO Cabin', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Washroom', 'Ceiling Lights', 'BPO Cabin', 2, 'Washroom', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Ceiling Lights' AND a.name = 'Washroom' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Washroom Exhaus Fan', 'Exhaust Fan', 'BPO Cabin', 1, 'Washroom Exhaus Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Exhaust Fan' AND a.name = 'Washroom Exhaus Fan' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Android Mobile', 'Android Mobile', 'BPO Cabin', 4, 'Android Mobile', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Android Mobile' AND a.name = 'Android Mobile' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Nokia Mobile', 'Nokia Mobile', 'BPO Cabin', 11, 'Nokia Mobile', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Nokia Mobile' AND a.name = 'Nokia Mobile' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wooden Storage Cupboard', 'Furniture', 'BPO Cabin', 1, 'Wooden Storage Cupboard', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Wooden Storage Cupboard' AND a.location = 'BPO Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Split A.C.', 'Air Conditioner', 'Library Cabin', 1, 'Split A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Split A.C.' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Library Cabin', 6, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'Library Cabin', 2, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'Library Cabin', 10, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Writing Board', 'Office Equipment', 'Library Cabin', 1, 'Writing Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Writing Board' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Camera', 'Cameras', 'Library Cabin', 1, 'Wall Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Wall Camera' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Godrej Locker', 'Office Equipment', 'Library Cabin', 1, 'Godrej Locker', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Godrej Locker' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'Library Cabin', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Guitar', 'Guitar', 'Library Cabin', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Guitar' AND a.name = 'Guitar' AND a.location = 'Library Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Split A.C.', 'Air Conditioner', 'Vocational Cabin', 2, 'Split A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Split A.C.' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Vocational Cabin', 14, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'Vocational Cabin', 4, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'Vocational Cabin', 12, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Camera', 'Cameras', 'Vocational Cabin', 2, 'Wall Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Cameras' AND a.name = 'Wall Camera' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ganpati Idol', 'Office Equipment', 'Vocational Cabin', 1, 'Ganpati Idol', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ganpati Idol' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Photo Frame', 'Office Equipment', 'Vocational Cabin', 9, 'Wall Photo Frame', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wall Photo Frame' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'Vocational Cabin', 3, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Speaker With Mike', 'Office Equipment', 'Vocational Cabin', 1, 'Speaker With Mike', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Speaker With Mike' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wooden Storage Board', 'Office Equipment', 'Vocational Cabin', 1, 'Wooden Storage Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wooden Storage Board' AND a.location = 'Vocational Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Split A.C.', 'Air Conditioner', 'Director''s Cabin', 1, 'Split A.C.', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Air Conditioner' AND a.name = 'Split A.C.' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Director''s Cabin', 6, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'Director''s Cabin', 1, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'Director''s Cabin', 4, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Sofa', 'Furniture', 'Director''s Cabin', 1, 'Office Sofa', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Office Sofa' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Plasma', 'Office Equipment', 'Director''s Cabin', 1, 'Plasma', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Plasma' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Laptop', 'Office Equipment', 'Director''s Cabin', 1, 'Laptop', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Laptop' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Projector', 'Office Equipment', 'Director''s Cabin', 1, 'Projector', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Projector' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Godrej Locker', 'Office Equipment', 'Director''s Cabin', 1, 'Godrej Locker', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Godrej Locker' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Blind Curtain', 'Blind Curtain', 'Director''s Cabin', 1, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Blind Curtain' AND a.name = 'Blind Curtain' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Speaker', 'Office Equipment', 'Director''s Cabin', 2, 'Speaker', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Speaker' AND a.location = 'Director''s Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Director''s Washroom', 2, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Director''s Washroom');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Exhaus Fan', 'Office Equipment', 'Director''s Washroom', 1, 'Exhaus Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Exhaus Fan' AND a.location = 'Director''s Washroom');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Kitchen', 9, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'Kitchen', 1, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera', 'Office Equipment', 'Kitchen', 2, 'Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Camera' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Plastic Chair', 'Office Chair', 'Kitchen', 4, 'Plastic Chair', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Plastic Chair' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Refrigerator', 'Kitchen Equipment', 'Kitchen', 1, 'Refrigerator', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Refrigerator' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Gas Induction', 'Kitchen Equipment', 'Kitchen', 1, 'Gas Induction', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Gas Induction' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'R.O. Plant', 'Kitchen Equipment', 'Kitchen', 1, 'R.O. Plant', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'R.O. Plant' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Writing Board', 'Kitchen Equipment', 'Kitchen', 1, 'Writing Board', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Writing Board' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Electric Hot Kettle', 'Kitchen Equipment', 'Kitchen', 1, 'Electric Hot Kettle', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Electric Hot Kettle' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Water Dispenser', 'Kitchen Equipment', 'Kitchen', 1, 'Water Dispenser', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Water Dispenser' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Coffee Machine', 'Kitchen Equipment', 'Kitchen', 1, 'Coffee Machine', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Coffee Machine' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Oven', 'Kitchen Equipment', 'Kitchen', 1, 'Oven', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Oven' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Server Rack', 'Kitchen Equipment', 'Kitchen', 1, 'Server Rack', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Server Rack' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Water Jug', 'Kitchen Equipment', 'Kitchen', 1, 'Water Jug', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Kitchen Equipment' AND a.name = 'Water Jug' AND a.location = 'Kitchen');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Light', 'Office Equipment', 'Reception Cabin', 6, 'Ceiling Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Light' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Ceiling Fan', 'Office Equipment', 'Reception Cabin', 2, 'Ceiling Fan', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Ceiling Fan' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera', 'Office Equipment', 'Reception Cabin', 1, 'Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Camera' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Chair', 'Office Chair', 'Reception Cabin', 2, NULL, 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Chair' AND a.name = 'Office Chair' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Office Sofa', 'Furniture', 'Reception Cabin', 4, 'Office Sofa', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Furniture' AND a.name = 'Office Sofa' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Laptop', 'Office Equipment', 'Reception Cabin', 3, 'Laptop', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Laptop' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Plasma', 'Office Equipment', 'Reception Cabin', 1, 'Plasma', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Plasma' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Teapoi Table', 'Office Equipment', 'Reception Cabin', 1, 'Teapoi Table', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Teapoi Table' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Photo Frame', 'Office Equipment', 'Reception Cabin', 20, 'Wall Photo Frame', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wall Photo Frame' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Awards', 'Office Equipment', 'Reception Cabin', 22, 'Awards', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Awards' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wooden Storage', 'Office Equipment', 'Reception Cabin', 1, 'Wooden Storage', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wooden Storage' AND a.location = 'Reception Cabin');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Light', 'Office Equipment', 'AFLF Staircase', 1, 'Wall Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wall Light' AND a.location = 'AFLF Staircase');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera', 'Office Equipment', 'AFLF Staircase', 1, 'Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Camera' AND a.location = 'AFLF Staircase');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Wall Light', 'Office Equipment', 'BSCT Staircase', 1, 'Wall Light', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Wall Light' AND a.location = 'BSCT Staircase');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Camera', 'Office Equipment', 'BSCT Staircase', 2, 'Camera', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Camera' AND a.location = 'BSCT Staircase');

INSERT INTO assets (name, category, location, quantity, remarks, status)
SELECT 'Shoes Plastic Rack', 'Office Equipment', 'BSCT Staircase', 3, 'Shoes Plastic Rack', 'available'
WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.category = 'Office Equipment' AND a.name = 'Shoes Plastic Rack' AND a.location = 'BSCT Staircase');

COMMIT;