-- 108: Reminder & Alarm module.
-- Tracks recurring reminders, due/renewal dates, alarms, notifications,
-- snooze/completion state and change history.

CREATE TABLE IF NOT EXISTS reminders (
  id bigserial PRIMARY KEY,
  title text,
  description text,
  category text,
  owner text,
  due_date date,
  renewal_date date,
  due_date_display text,
  renewal_date_display text,
  frequency_type text,
  frequency_interval integer,
  day_of_month integer,
  month_of_year integer,
  display_frequency text,
  priority text,
  status text NOT NULL DEFAULT 'Upcoming',
  alarm_enabled boolean NOT NULL DEFAULT false,
  reminder_enabled boolean NOT NULL DEFAULT false,
  reminder_minutes_before integer,
  reminder_time text,
  notification_enabled boolean NOT NULL DEFAULT false,
  snooze_until timestamptz,
  notes text,
  is_deleted boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminder_history (
  id bigserial PRIMARY KEY,
  reminder_id bigint REFERENCES reminders(id) ON DELETE CASCADE,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_cols jsonb,
  before_data jsonb,
  after_data jsonb,
  action text
);

CREATE TABLE IF NOT EXISTS reminder_notifications (
  id bigserial PRIMARY KEY,
  reminder_id bigint REFERENCES reminders(id) ON DELETE CASCADE,
  title text,
  body text,
  level text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminder_settings (
  id bigserial PRIMARY KEY,
  user_key text,
  default_reminder_time text,
  default_reminder_before integer,
  default_alarm boolean NOT NULL DEFAULT false,
  default_notification boolean NOT NULL DEFAULT false,
  browser_notifications boolean NOT NULL DEFAULT false,
  alarm_sound_enabled boolean NOT NULL DEFAULT true,
  alarm_volume numeric NOT NULL DEFAULT 0.7,
  due_soon_threshold integer NOT NULL DEFAULT 7,
  auto_create_next_recurring boolean NOT NULL DEFAULT true,
  notification_frequency text,
  timezone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminders_due_date ON reminders(due_date);
CREATE INDEX IF NOT EXISTS idx_reminders_category ON reminders(category);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner);
CREATE INDEX IF NOT EXISTS idx_reminders_not_deleted ON reminders(is_deleted);
CREATE INDEX IF NOT EXISTS idx_reminder_history_reminder ON reminder_history(reminder_id);
CREATE INDEX IF NOT EXISTS idx_reminder_notifications_reminder ON reminder_notifications(reminder_id);
CREATE INDEX IF NOT EXISTS idx_reminder_notifications_read ON reminder_notifications(read);
