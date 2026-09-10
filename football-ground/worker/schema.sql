-- Coal Park Lane — booking backend (D1: coalparklane)
-- Reference copy of the live schema. The worker also creates this on first run.

CREATE TABLE IF NOT EXISTS bookings (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  source        TEXT NOT NULL DEFAULT 'enquiry',   -- 'enquiry' (from the website) | 'manual' (added by you)
  status        TEXT NOT NULL DEFAULT 'new',        -- new | contacted | confirmed | declined | cancelled
                                                     --   (Phase 2 will add: pending_payment | paid)
  name          TEXT,
  email         TEXT,
  phone         TEXT,
  booking_date  TEXT,       -- YYYY-MM-DD
  booking_time  TEXT,       -- HH:MM
  duration_mins INTEGER,    -- optional, used for the calendar view
  pitch         TEXT,       -- which space (5-a-side / full size / …)
  use_for       TEXT,       -- what it's for (training / league / …)
  message       TEXT,       -- the enquirer's message
  admin_notes   TEXT,       -- private notes, never shown to the enquirer
  amount        REAL,       -- Phase 2: price of the booking
  paid          INTEGER NOT NULL DEFAULT 0  -- Phase 2: 1 once paid online
);

CREATE INDEX IF NOT EXISTS idx_bookings_date    ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at);
