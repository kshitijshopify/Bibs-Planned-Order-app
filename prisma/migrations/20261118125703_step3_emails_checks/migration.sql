-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN "missingSince" DATETIME;

-- CreateTable
CREATE TABLE "AppSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "emailsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "storefrontUrl" TEXT,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "kind" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "uniqueId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT,
    "properties" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "EmailEvent_shop_status_idx" ON "EmailEvent"("shop", "status");

-- CreateIndex
CREATE INDEX "EmailEvent_shop_createdAt_idx" ON "EmailEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "EmailEvent_shop_customerId_idx" ON "EmailEvent"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_shop_uniqueId_key" ON "EmailEvent"("shop", "uniqueId");
