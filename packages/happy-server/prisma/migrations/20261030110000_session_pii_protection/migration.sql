ALTER TABLE "Session" ADD COLUMN "piiProtection" BOOLEAN NOT NULL DEFAULT false;
CREATE FUNCTION enforce_session_pii_protection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."piiProtection" IS DISTINCT FROM OLD."piiProtection" THEN
    RAISE EXCEPTION 'pii-protection-immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_pii_protection_guard BEFORE UPDATE OF "piiProtection" ON "Session"
  FOR EACH ROW EXECUTE FUNCTION enforce_session_pii_protection();
