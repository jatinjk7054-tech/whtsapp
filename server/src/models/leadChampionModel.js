import db from '../config/db.js';

export const getAnnouncementByDate = async (date) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('*')
    .eq('announcement_date', date)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
};

// All announcements for a date (one per range winner).
export const getAnnouncementsByDate = async (date) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('*')
    .eq('announcement_date', date)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

// Does the date+range pair already have an announcement?
export const getAnnouncementByDateAndSlab = async (date, slabId) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('id')
    .eq('announcement_date', date)
    .eq('slab_id', slabId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

// Latest announcement (for FRO-facing display). Optional date filter for today.
export const getLatestAnnouncement = async (date) => {
  let q = db
    .from('lead_champion_announcements')
    .select('*')
    .order('announcement_date', { ascending: false })
    .limit(1);
  if (date) q = q.eq('announcement_date', date);
  const { data, error } = await q;
  if (error) throw error;
  return (data && data[0]) || null;
};

// All announcements for a date (one per range), newest date last but
// deterministic per date (used by the daily FRO champion list).
export const getAnnouncementsForDate = async (date) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('*')
    .eq('announcement_date', date)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

// Full history of champion announcements, newest first.
export const getAnnouncements = async () => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('*')
    .order('announcement_date', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

export const getAnnouncementById = async (id) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

// Publish a winner celebration exactly once: attaches the uploaded winner
// photo + congrats message and stamps celebrated_at. The IS NULL guard makes
// a second Send a no-op (returns null) so a celebration can never be
// re-published or resurrected after dismissal.
export const updateAnnouncementCelebration = async (id, { photoUrl, message }) => {
  const patch = { celebrated_at: new Date().toISOString() };
  if (photoUrl) patch.winner_photo_url = photoUrl;
  if (typeof message === 'string' && message.trim()) patch.message = message.trim();
  const { data, error } = await db
    .from('lead_champion_announcements')
    .update(patch)
    .eq('id', id)
    .is('celebrated_at', null)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

// Hard delete an announcement row. Returns the deleted row so callers can
// confirm / broadcast the removal.
export const deleteAnnouncement = async (id) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .delete()
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const insertAnnouncement = async ({
  announcement_date,
  slab_id,
  slab_label,
  started_at,
  ended_at,
  fro_worker_id,
  fro_name,
  total_leads,
  qualified_leads,
  total_amount,
  lead_incentive,
  slab_bonus,
  champion_bonus,
  total_incentive,
  message,
  announced_by,
}) => {
  const { data, error } = await db
    .from('lead_champion_announcements')
    .insert([{
      announcement_date,
      slab_id,
      slab_label,
      started_at,
      ended_at,
      fro_worker_id,
      fro_name,
      total_leads,
      qualified_leads,
      total_amount,
      lead_incentive,
      slab_bonus,
      champion_bonus,
      total_incentive,
      message,
      announced_by,
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
};