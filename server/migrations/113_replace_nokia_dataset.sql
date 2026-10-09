-- 113: REPLACE the previous NOKIA (UFRS) SIM Card data with the new 16-column
-- UFRS 1-101 dataset. Android data is NOT touched.
--
--   * Adds the columns required by the dataset (calling_mobile, use_for,
--     team_leader_name, user_name, days_left) plus a new remark column. The
--     dataset's Remark values are stored in remark; signature is left
--     untouched (Android's Owner column keeps using it).
--   * Removes the previous Nokia rows (Mobile ID prefixed "UFRS") and their
--     replacement/edit history, then inserts ONLY the 101 supplied rows.
--   * Dates are stored as supplied (dd-Mon-yy -> ISO). The invalid '0-Jan-00'
--     becomes NULL; '28-Jan-00' is stored as 2000-01-28 (renders 28-Jan-00).
--   * 'NA' / 'NO SIM' / blank cells are preserved verbatim.
--
-- Safe to re-run (statements are idempotent).

ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS calling_mobile text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS use_for text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS team_leader_name text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS user_name text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS days_left integer;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS remark text;

DELETE FROM sim_card_replacements
  WHERE sim_card_id IN (SELECT id FROM sim_cards WHERE mobile_id ILIKE 'UFRS%');
DELETE FROM sim_card_history
  WHERE sim_card_id IN (SELECT id FROM sim_cards WHERE mobile_id ILIKE 'UFRS%');
DELETE FROM sim_cards WHERE mobile_id ILIKE 'UFRS%';

INSERT INTO sim_cards
  (mobile_id, calling_mobile, device_model, imei, status, use_for, team_leader_name, user_name, team, remark, issue_date, expiry_date, days_left, sim_1, sim_2, replacement_count)
VALUES
  ('UFRS 1', 'Nokia', 'TA- 1575', '351775762518654', 'Active', 'HR', 'NIKHIL', 'BHUMIKA', 'HR', NULL, '2026-08-16', '2026-09-13', 8, '7506788367', NULL, 1),
  ('UFRS 2', 'Nokia', 'TA-1304', '353155114058170', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Battery Demage', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 3', 'Nokia', 'TA-1304', '358040747543290', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152063827', '9152106733', 2),
  ('UFRS 4', 'Nokia', 'TA-1447', '351051350896260', 'Active', 'MANN', 'SONALI ', 'RUCHIRA M', 'UFS 5', NULL, '2026-08-18', '2026-09-15', 10, '9920784613', NULL, 1),
  ('UFRS 5', 'Nokia', 'TA-1203', '357750101094158', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 6', 'Nokia', 'TA1304', '358040747541583', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 7', 'Nokia', 'TA -1304', '358040749596585', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152406041', NULL, 1),
  ('UFRS 8', 'Nokia', 'TA-1447', '351051350967772', 'Active', 'MANN', 'ARCHANA', 'EXTRA', 'UFS 3', NULL, '2026-08-16', '2026-09-13', 8, '7506780579', NULL, 1),
  ('UFRS 9', 'Nokia', 'TA-1304', '358040749595595', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 10', 'Nokia', 'TA-1304', '358040749596700', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Battery Demage', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 11', 'Nokia', 'TA-1473', '354294865262290', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 12', 'Nokia', 'TA-1473', '353849647806572', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Battery Demage', '2026-03-22', '2026-04-19', -139, 'NA', NULL, 0),
  ('UFRS 13', 'Nokia', 'TA-1447', '351051350811590', 'Active', 'MANN', 'ARCHANA', 'EXTRA', 'UFS 3', NULL, '2026-08-25', '2026-09-22', 17, '9920547958', NULL, 1),
  ('UFRS 14', 'Nokia', 'TA-1304', '358040749593814', 'Active', 'AFLF', 'NEHA', 'EXTRA', 'UFS 1', NULL, '2026-08-04', '2026-09-01', -4, '7506527530', NULL, 1),
  ('UFRS 15', 'Nokia', 'TA-1304', '358040747541963', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 16', 'Nokia', 'TA-1304', '358040747630881', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 17', 'Nokia', 'TA-1304', '358040747611568', 'Active', 'AFLF', 'VARSHA', 'KSHITIJA J', 'UFS 4', NULL, '2026-08-04', '2026-09-01', -4, '7506184791', NULL, 1),
  ('UFRS 18', 'Nokia', 'TA-1304', '358040747543225', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 19', 'Nokia', 'TA-1304', '358040749596676', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 20', 'Nokia', 'TA-1304', '358040747541518', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Battery Demage', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 21', 'Nokia', 'TA-1473', '354294863387388', 'Active', 'AFLF', 'ARCHANA', 'PRATHNA', 'UFS 3', NULL, '2026-08-18', '2026-09-15', 10, '9920594831', NULL, 1),
  ('UFRS 22', 'Nokia', 'TA- 1575', '358723419025932', 'Active', 'BSCT', 'VARSHA', 'HIRAL W', 'UFS 4', NULL, '2026-08-25', '2026-09-22', 17, '9920651893', NULL, 1),
  ('UFRS 23', 'Nokia', 'TA- 1575', '359014723463541', 'Active', 'BSCT', 'ARCHANA', 'MAYA JADHAO', 'UFS 3', NULL, '2026-08-18', '2026-09-15', 10, '9920413807', NULL, 1),
  ('UFRS 24', 'Nokia', 'TA-1575', '359014723523807', 'Active', 'MANN', 'SONALI ', 'KHUSHI V', 'UFS 5', NULL, '2026-08-04', '2026-09-01', -4, '7506934197', NULL, 1),
  ('UFRS 25', 'Nokia', 'TA- 1575', '359014723761506', 'Active', 'BSCT', 'DEEPALI', 'DHANASHREE', 'UFS 2', NULL, '2026-08-09', '2026-09-06', 1, '7506353610', NULL, 1),
  ('UFRS 26', 'Nokia', 'TA- 1575', '359014723355192', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 27', 'Nokia', 'TA-1575', '357891910522052', 'Active', 'BSCT', 'ARCHANA', 'LAXMI MISTRY', 'UFS 3', NULL, '2026-08-09', '2026-09-06', 1, '7506591290', NULL, 1),
  ('UFRS 28', 'Nokia', 'TA- 1575', '358723414326756', 'Active', 'BSCT', 'ARCHANA', 'EXTRA', 'UFS 3', NULL, '2026-08-18', '2026-09-15', 10, '9920246131', NULL, 1),
  ('UFRS 29', 'Nokia', 'TA- 1575', '357891918633976', 'Active', 'BSCT', 'SONALI ', 'ALL TEAM', 'UFS 5', NULL, '2026-08-04', '2026-09-01', -4, '7506934103', NULL, 1),
  ('UFRS 30', 'Nokia', 'TA- 1575', '357650135173236', 'Active', 'AFLF', 'NEHA', 'MONALI', 'UFS 1', NULL, '2026-08-09', '2026-09-06', 1, '7506591349', NULL, 1),
  ('UFRS 31', 'Nokia', 'TA-1447', '351051352299380', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 32', 'Nokia', 'TA-1575', '357650135159508', 'No Sim', 'BSCT', 'ARCHANA', 'EXTRA', 'UFS 3', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 33', 'Nokia', 'TA-1575', '357650138881454', 'Active', 'BSCT', 'DEEPALI', 'DEEPALI GAUTAM', 'UFS 2', NULL, '2026-08-04', '2026-09-01', -4, '7506591622', NULL, 1),
  ('UFRS 34', 'Nokia', 'TA-1575', '357650138882624', 'Active', 'BSCT', 'VARSHA', 'SIMRAN', 'UFS 4', NULL, '2026-08-25', '2026-09-22', 17, '9920652371', NULL, 1),
  ('UFRS 35', 'Nokia', 'TA- 1575', '358723417806606', 'Active', 'MANN', 'SONALI ', 'REENA M', 'UFS 5', NULL, '2026-08-25', '2026-09-22', 17, '9619159928', NULL, 1),
  ('UFRS 36', 'Nokia', 'TA-1447', '351051354660456', 'In-Active', 'HR', 'NIKHIL', 'NIKHIL', 'HR', NULL, '2026-02-03', '2026-03-03', -186, '7039767105', NULL, 1),
  ('UFRS 37', 'Nokia', 'TA-1304', '353155114010973', 'Active', 'Locker', 'Locker', 'Locker', 'Locker', NULL, '2026-08-25', '2026-09-22', 17, '9920074673', NULL, 1),
  ('UFRS 38', 'Nokia', 'TA-1447', '351091351819071', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 39', 'Nokia', 'TA-1473', '354294866241954', 'Active', 'HR', 'NIKHIL', 'POOJA', 'HR', NULL, '2026-08-25', '2026-09-22', 17, '9920354153', NULL, 1),
  ('UFRS 40', 'Nokia', 'TA-1203', '357750107153727', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, '2000-01-28', -46242, 'NA', NULL, 0),
  ('UFRS 41', 'Nokia', 'TA-1304', '358040747619934', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 42', 'Nokia', 'TA- 1304', '358040749594127', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152470722', NULL, 1),
  ('UFRS 43', 'Nokia', 'TA- 1304', '358040747618324', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152837560', '9152342467', 2),
  ('UFRS 44', 'Nokia', 'TA-1304', '358040747543258', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 45', 'Nokia', 'TA-1304', '358040749595470', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 46', 'Nokia', 'TA-1304', '358040747631152', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Battery Demage', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 47', 'Nokia', 'TA-1304', '358040747631608', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 48', 'Nokia', 'TA-1304', '353155114007011', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, NULL, NULL, 0),
  ('UFRS 49', 'Nokia', 'TA-1447', '351051350982607', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 50', 'Nokia', 'TA-1203', '357750107153628', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, NULL, NULL, 0),
  ('UFRS 51', 'Nokia', 'TA-1447', '351051350826929', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'Network Problem', NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 52', 'Nokia', 'TA-1304', '358040747619439', 'Active', 'MANN', 'NEHA', 'ALL TEAM', 'UFS 1', NULL, '2026-08-05', '2026-09-02', -3, '7506591753', NULL, 1),
  ('UFRS 53', 'Nokia', 'TA-1473', '354294863320892', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, '9152063827', NULL, 1),
  ('UFRS 54', 'Nokia', 'TA-1473', '354294863004520', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', 'No Battray', NULL, NULL, NULL, '9152470656', NULL, 1),
  ('UFRS 55', 'Nokia', 'TA-1575', '358723417065740', 'Active', 'AFLF', 'DEEPALI', 'PRIYA TIWARI', 'UFS 2', NULL, '2026-08-25', '2026-09-22', 17, '9920953968', NULL, 1),
  ('UFRS 56', 'Nokia', 'TA-1575', '357891917944762', 'Active', 'MANN', 'ARCHANA', 'EXTRA', 'UFS 3', NULL, '2026-08-18', '2026-09-15', 10, '9920411235', NULL, 1),
  ('UFRS 57', 'Nokia', 'TA-1010', '354203102158161', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152709202', NULL, 1),
  ('UFRS 58', 'Nokia', 'TA-1473', '353849647054033', 'Active', 'BSCT', 'NEHA', 'RAVINA JAIN', 'UFS 1', NULL, '2026-08-09', '2026-09-06', 1, '7506763472', NULL, 1),
  ('UFRS 59', 'Nokia', 'TA-1304', '358823969167348', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 60', 'Nokia', 'TA-1304', '358040749596627', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, '9152470536', NULL, 1),
  ('UFRS 61', 'Nokia', 'TA-1575', '357650135135839', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 62', 'Nokia', 'TA-1575', '357650135160167', 'Active', 'BSCT', 'NEHA', 'KANCHAN', 'UFS 1', NULL, '2026-08-17', '2026-09-14', 9, '7506220434', NULL, 1),
  ('UFRS 63', 'Nokia', 'TA-1447', '351051351861339', 'Active', 'AFLF', 'VARSHA', 'POOJA JAISWAL', 'UFS 4', 'Deepika New Emp', '2026-08-04', '2026-09-01', -4, '7506591098', NULL, 1),
  ('UFRS 64', 'Nokia', 'TA-1304', '358823969167413', 'Active', 'AFLF', 'VARSHA', 'SANGEETA', 'UFS 4', NULL, '2026-08-04', '2026-09-01', -4, '7506527120', NULL, 1),
  ('UFRS 65', 'Nokia', 'TA-1575', '357650135083427', 'Active', 'AFLF', 'DEEPALI', 'CHAYA', 'UFS 2', NULL, '2026-08-16', '2026-09-13', 8, '7506483046', NULL, 1),
  ('UFRS 66', 'Nokia', 'TA-1304', '358823969167397', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 67', 'Nokia', 'TA-1304', '358040747618209', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 68', 'Nokia', 'TA- 1575', '357891918600553', 'Active', 'MANN', 'SONALI ', 'REESHMA S', 'UFS 5', NULL, '2026-08-09', '2026-09-06', 1, '7506934813', NULL, 1),
  ('UFRS 69', 'Nokia', 'TA-1304', '358040749596882', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 70', 'Nokia', 'TA-1473', '354294865111026', 'Active', 'BSCT', 'ARCHANA', 'EXTRA', 'UFS 3', 'Prathna New Emp', '2026-08-16', '2026-09-13', 8, '7506110578', NULL, 1),
  ('UFRS 71', 'Nokia', 'TA-1473', '354294863509080', 'Active', 'AFLF', 'NEHA', 'SHWETA VISHAKAMA', 'UFS 1', NULL, '2026-08-09', '2026-09-06', 1, '7506931040', NULL, 1),
  ('UFRS 72', 'Nokia', 'TA-1304', '358040747541989', 'Active', 'Locker', 'Locker', 'Locker', 'Locker', NULL, '2026-01-28', '2026-02-25', 1, '9152330641', NULL, 1),
  ('UFRS 73', 'Nokia', 'TA-1304', '358271929063530', 'Active', 'BSCT', 'DEEPALI', 'NAZAMI', 'UFS 2', 'Nazneen New Emp', '2026-08-18', '2026-09-15', 10, '9920952283', NULL, 1),
  ('UFRS 74', 'Nokia', 'TA-1304', '358271924114916', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 75', 'Nokia', 'TA- 1575', '359014723598692', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 76', 'Nokia', 'TA- 1575', '358723417575243', 'Active', 'BSCT', 'NEHA', 'NEHA KHARWAR', 'UFS 1', NULL, '2026-08-17', '2026-09-14', 9, '7506891567', NULL, 1),
  ('UFRS 77', 'Nokia', 'TA-1575', '357891918738890', 'Active', 'AFLF', 'VARSHA', 'VARSHA S', 'UFS 4', NULL, '2026-08-25', '2026-09-22', 17, '9920716824', NULL, 1),
  ('UFRS 78', 'Nokia', 'TA-1575', '357891918688467', 'Active', 'BSCT', 'ARCHANA', 'SUSHAMA A', 'UFS 3', NULL, '2026-08-04', '2026-09-01', -4, '7506527823', NULL, 1),
  ('UFRS 79', 'Nokia', 'TA-1575', '359014723890438', 'Active', 'BSCT', 'ARCHANA', 'MAMTA', 'UFS 3', NULL, '2026-08-04', '2026-09-01', -4, '7506527529', NULL, 1),
  ('UFRS 80', 'Nokia', 'TA-1575', '357891918849770', 'Active', 'BSCT', 'NEHA', 'MAHIMA', 'UFS 1', NULL, '2026-08-17', '2026-09-14', 9, '7506354749', NULL, 1),
  ('UFRS 81', 'Nokia', 'TA-1575', '357891910042077', 'Active', 'Locker', 'Locker', 'Locker', 'Locker', 'Kanchan Chauhan New Emp', '2026-08-09', '2026-09-06', 1, '7506763596', NULL, 1),
  ('UFRS 82', 'Nokia', 'TA- 1575', '357891918739302', 'Active', 'BSCT', 'NEHA', 'POOJA PAL', 'UFS 1', NULL, '2026-08-26', '2026-09-23', 18, '9920415962', NULL, 1),
  ('UFRS 83', 'Nokia', 'TA-1575', '358723417735664', 'Active', 'AFLF', 'ARCHANA', 'SIDDHI', 'UFS 3', NULL, '2026-08-04', '2026-09-01', -4, '7506527613', NULL, 1),
  ('UFRS 84', 'Nokia', 'TA-1304', '358040747543035', 'Active', 'BSCT', 'DEEPALI', 'RIDDHI PATLE', 'UFS 2', NULL, '2026-08-04', '2026-09-01', -4, '7506527604', NULL, 1),
  ('UFRS 85', 'Nokia', 'TA-1304', '358040747630014', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 86', 'Nokia', 'TA-1575', '351775762495499', 'Active', 'MANN', 'SONALI ', 'ANKITA C', 'UFS 5', NULL, '2026-08-18', '2026-09-15', 10, '9920954434', NULL, 1),
  ('UFRS 87', 'Nokia', 'TA-1575', '351777562497388', 'Active', 'MANN', 'VARSHA', 'VARSHA S', 'UFS 4', NULL, '2026-08-16', '2026-09-13', 8, '7506242634', NULL, 1),
  ('UFRS 88', 'Nokia', 'TA-1575', '351775762498964', 'Active', 'AFLF', 'VARSHA', 'VARSHA S', 'UFS 4', NULL, '2026-08-25', '2026-09-22', 17, '9920955896', NULL, 1),
  ('UFRS 89', 'Nokia', 'TA-1575', '351775762497438', 'No Sim', 'MANN', 'SONALI ', 'RAVINA A', 'UFS 5', NULL, NULL, NULL, NULL, 'NO SIM', NULL, 0),
  ('UFRS 90', 'Nokia', 'TA- 1575', '351775762534313', 'Active', 'MANN', 'SONALI ', 'MARWA K', 'UFS 5', NULL, '2026-08-16', '2026-09-13', 8, '7506009507', NULL, 1),
  ('UFRS 91', 'Nokia', 'TA- 1575', '351775762510081', 'Active', 'MANN', 'SONALI ', 'RUTHVI G', 'UFS 5', NULL, '2026-08-09', '2026-09-06', 1, '7506185792', NULL, 1),
  ('UFRS 92', 'Nokia', 'TA- 1575', '351775762522490', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 93', 'Nokia', 'TA- 1575', '351775762518787', 'Active', 'BSCT', 'VARSHA', 'MUSHKAN ', 'UFS 4', NULL, '2026-08-09', '2026-09-06', 1, '7506592054', NULL, 1),
  ('UFRS 94', 'Nokia', 'TA- 1575', '351775762559724', 'Active', 'BSCT', 'ARCHANA', 'HEMA TIWARI', 'UFS 3', NULL, '2026-08-09', '2026-09-06', 1, '7506591602', NULL, 1),
  ('UFRS 95', 'Nokia', 'TA-1575', '357650135034958', 'Active', 'MANN', 'SONALI ', 'SONALI W', 'UFS 5', NULL, '2026-08-09', '2026-09-06', 1, '7506934668', NULL, 1),
  ('UFRS 96', 'Nokia', 'TA-1575', '357650135018662', 'Active', 'AFLF', 'NEHA', 'THEHSEEN', 'UFS 1', NULL, '2026-08-16', '2026-09-13', 8, '7506247092', NULL, 1),
  ('UFRS 97', 'Nokia', 'TA-1575', '358723417809345', 'Active', 'BSCT', 'ARCHANA', 'ARCHANA', 'UFS 3', NULL, '2026-08-09', '2026-09-06', 1, '7506053704', NULL, 1),
  ('UFRS 98', 'Nokia', 'TA-1575', '359014723200133', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 99', 'Nokia', 'TA-1575', '359014723843098', 'Active', 'BSCT', 'ARCHANA', 'SAKSHI SINGH', 'UFS 3', NULL, '2026-08-04', '2026-09-01', -4, '7506591762', NULL, 1),
  ('UFRS 100', 'Nokia', 'TA-1575', '357650135000991', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0),
  ('UFRS 101', 'Nokia', 'MX-1', '911318052788415', 'No Sim', 'Locker', 'Locker', 'Locker', 'Locker', NULL, NULL, NULL, NULL, 'NA', NULL, 0);
