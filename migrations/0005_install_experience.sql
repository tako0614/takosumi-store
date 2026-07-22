-- Optional install-form presentation grouping for a listing's inputs, stored as
-- a JSON object (spec/listing.ts `ListingInstallExperience`). NULL when the
-- publisher supplied no grouping; the install still runs from source + inputs.
ALTER TABLE listings ADD COLUMN install_experience TEXT;
