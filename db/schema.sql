-- Synthetic P3-only catalog. Eligibility policy is not implemented here.
CREATE TABLE IF NOT EXISTS course_offers (
  offer_id TEXT PRIMARY KEY CHECK (length(offer_id) BETWEEN 1 AND 80),
  tenant_id TEXT NOT NULL CHECK (tenant_id IN ('academy-a', 'academy-b')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  required_skills TEXT[] NOT NULL DEFAULT '{}' CHECK (array_position(required_skills, NULL) IS NULL),
  weekly_study_hours INTEGER NOT NULL CHECK (weekly_study_hours BETWEEN 1 AND 168),
  active BOOLEAN NOT NULL
);
