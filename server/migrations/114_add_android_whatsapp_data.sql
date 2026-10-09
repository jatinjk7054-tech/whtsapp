-- 114: ADD the Android Whatsapp SIM data (46 rows) for the "Android Whatsapp" tab.
--
--   * Adds w1_name..w4_name columns (WhatsApp account label per SIM slot).
--   * WhatsApp numbers are stored in sim_1..sim_4.
--   * Mobile ID = "Android Whatsapp <n>", matching the tab filter.
--   * Only Android Whatsapp rows are touched; existing data is replaced on re-run.
--
-- Safe to re-run (statements are idempotent).

ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS w1_name text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS w2_name text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS w3_name text;
ALTER TABLE sim_cards ADD COLUMN IF NOT EXISTS w4_name text;

DELETE FROM sim_card_replacements
  WHERE sim_card_id IN (SELECT id FROM sim_cards WHERE mobile_id ILIKE 'android whatsapp%');
DELETE FROM sim_card_history
  WHERE sim_card_id IN (SELECT id FROM sim_cards WHERE mobile_id ILIKE 'android whatsapp%');
DELETE FROM sim_cards WHERE mobile_id ILIKE 'android whatsapp%';

INSERT INTO sim_cards
  (mobile_id, w1_name, sim_1, w2_name, sim_2, w3_name, sim_3, w4_name, sim_4)
VALUES
  ('Android Whatsapp 1', 'BSCT', '8879034034', 'AFLF', '9594817011', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 2', 'BSCT', '9821452580', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 3', 'BSCT', '9987344338', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 4', 'BSCT', '9820646225', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 5', 'BSCT', '9920246131', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 6', 'AFLF', '7506373614', 'AFLF', '9920953968', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 7', 'BSCT', '9820645607', 'BSCT', '9594148931', 'AFLF', '8692815947', NULL, NULL),
  ('Android Whatsapp 8', 'BSCT', '9619565932', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 9', 'BSCT', '9920893993', 'BSCT', '9594491859', 'BSCT', '9820644749', NULL, NULL),
  ('Android Whatsapp 10', 'MANN', '7506242634', 'BSCT', '9892268000', 'AFLF', '8657339354', NULL, NULL),
  ('Android Whatsapp 11', 'BSCT', '9833400532', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 12', 'AFLF', '9930595536', 'BSCT', '9820247304', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 13', 'BSCT', '9619598101', 'AFLF', '9594557165', 'BSCT', '9594641646', NULL, NULL),
  ('Android Whatsapp 14', 'AFLF', '9152696568', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 15', 'BSCT', '9702361571', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 16', 'MANN', '9820634271', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 17', 'BSCT', '9152991271', 'BSCT', '9930957856', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 18', 'BSCT', '9769417491', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 19', 'BSCT', '9819394817', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 20', 'AFLF', '9702468297', 'AFLF', '9152330242', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 21', 'BSCT', '7506527530', 'BSCT', '9594120936', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 22', 'BSCT', '9152304318', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 23', 'BSCT', '9702597564', 'BSCT', '9769396701', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 24', 'BSCT', '7506591602', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 25', 'AFLF', '9920716824', 'BSCT', '9769279265', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 26', 'BSCT', '8425804901', 'AFLF', '9152330964', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 27', 'AFLF', '9594775052', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 28', 'BSCT', '8657938496', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 29', 'AFLF', '9152601547', 'BSCT', '8425802861', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 30', 'BSCT', '9930852952', 'BSCT', '9594663326', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 31', 'BSCT', '9076288078', 'MANN', '9820937129', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 32', 'BSCT', '9819394182', 'AFLF', '9930546027', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 33', 'AFLF', '9594102083', 'BSCT', '9930396443', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 34', 'BSCT', '8879194393', 'AFLF', '9930359547', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 35', 'MANN', '9930984694', 'MANN', '9930931374', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 36', 'MANN', '7506591753', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 37', 'AFLF', '7506053704', 'AFLF', '9167739936', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 38', 'BSCT', '9594319272', 'BSCT', '9930524721', 'BSCT', '7506110578', NULL, NULL),
  ('Android Whatsapp 39', 'MANN', '9920183768', 'BSCT', '9920117479', 'AFLF', '7506781056', 'AFLF', '7506247092'),
  ('Android Whatsapp 40', 'MANN', '9920740626', 'BSCT', '9619159928', 'BSCT', '7506781153', NULL, NULL),
  ('Android Whatsapp 41', 'AFLF', '9702542662', 'AFLF', '9920634658', 'AFLF', '9769386601', 'AFLF', '7045645437'),
  ('Android Whatsapp 42', 'AFLF', '9594157931', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 43', 'BSCT', '8657591901', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 44', 'AFLF', '9152842139', NULL, NULL, NULL, NULL, NULL, NULL),
  ('Android Whatsapp 45', 'BSCT', '9920784613', 'MANN', '7506934813', NULL, NULL, NULL, NULL),
  ('Android Whatsapp 46', 'BSCT', '7506527529', 'BSCT', '7045934703', NULL, NULL, NULL, NULL);
