ALTER TABLE "Session" ADD COLUMN "piiMode" TEXT;
UPDATE "Session" SET "piiMode" = CASE WHEN "piiProtection" THEN 'isolated' ELSE 'none' END;
ALTER TABLE "Session" ALTER COLUMN "piiMode" SET NOT NULL;
ALTER TABLE "Session" ADD CONSTRAINT "Session_piiMode_consistent" CHECK (
  ("piiMode"='none' AND NOT "piiProtection") OR
  ("piiMode" IN ('isolated','host-masking') AND "piiProtection")
);
-- Legacy writers may only retain their existing meaning, never select host masking implicitly.
CREATE FUNCTION enforce_session_pii_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW."piiMode" IS NULL THEN
    NEW."piiMode" := CASE WHEN NEW."piiProtection" THEN 'isolated' ELSE 'none' END;
  ELSIF TG_OP='UPDATE' AND NEW."piiMode" IS DISTINCT FROM OLD."piiMode" THEN
    RAISE EXCEPTION 'pii-mode-immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_pii_mode_guard BEFORE INSERT OR UPDATE ON "Session"
  FOR EACH ROW EXECUTE FUNCTION enforce_session_pii_mode();
