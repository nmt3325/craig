-- CreateTable
CREATE TABLE "NotionChannel" (
    "channelId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotionChannel_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE INDEX "NotionChannel_guildId_idx" ON "NotionChannel"("guildId");
