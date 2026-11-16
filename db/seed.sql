-- Fictional offers and prices, not real provider inventory. No existing row is overwritten.
INSERT INTO course_offers (offer_id, tenant_id, title, price_cents, currency, required_skills, weekly_study_hours, active)
VALUES
 ('p3-a-101', 'academy-a', 'Synthetic Python Foundations', 12000, 'USD', '{}', 4, TRUE),
 ('p3-a-102', 'academy-a', 'Synthetic Backend APIs', 24000, 'USD', '{basic-python}', 6, TRUE),
 ('p3-a-103', 'academy-a', 'Synthetic Retired Workshop', 5000, 'USD', '{}', 2, FALSE),
 ('p3-b-101', 'academy-b', 'Synthetic SQL Foundations', 9500, 'USD', '{}', 3, TRUE),
 ('p3-b-102', 'academy-b', 'Synthetic Data Services', 18500, 'USD', '{basic-sql}', 5, TRUE),
 ('p3-b-103', 'academy-b', 'Synthetic Archived Seminar', 7000, 'USD', '{}', 2, FALSE)
ON CONFLICT (offer_id) DO NOTHING;
