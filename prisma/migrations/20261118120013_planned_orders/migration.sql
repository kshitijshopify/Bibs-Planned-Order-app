-- CreateTable
CREATE TABLE "PlanItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL,
    "releaseDate" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'p',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlanCustomer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "companyName" TEXT,
    "profileAt" DATETIME,
    "notices" TEXT NOT NULL DEFAULT '[]',
    "planUpdatedAt" DATETIME,
    "migratedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "title" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PlanItem_shop_productId_idx" ON "PlanItem"("shop", "productId");

-- CreateIndex
CREATE INDEX "PlanItem_shop_releaseDate_idx" ON "PlanItem"("shop", "releaseDate");

-- CreateIndex
CREATE UNIQUE INDEX "PlanItem_shop_customerId_variantId_key" ON "PlanItem"("shop", "customerId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanCustomer_shop_customerId_key" ON "PlanCustomer"("shop", "customerId");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_createdAt_idx" ON "ActivityLog"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_customerId_idx" ON "ActivityLog"("shop", "customerId");
