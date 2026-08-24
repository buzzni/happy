-- aplus §6-1 B1: machineKey 의 서버 몫 봉투 (write-once, 계정 몫과 별개 컬럼)
ALTER TABLE "Machine" ADD COLUMN "serverDataEncryptionKey" BYTEA;
