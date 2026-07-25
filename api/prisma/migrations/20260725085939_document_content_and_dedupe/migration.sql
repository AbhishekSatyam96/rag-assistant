/*
  Warnings:

  - You are about to drop the column `filename` on the `Document` table. All the data in the column will be lost.
  - You are about to drop the column `mimeType` on the `Document` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,contentHash]` on the table `Document` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `content` to the `Document` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contentHash` to the `Document` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `Document` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Document` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Document" DROP COLUMN "filename",
DROP COLUMN "mimeType",
ADD COLUMN     "chunkCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "content" TEXT NOT NULL,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "Document_userId_createdAt_idx" ON "Document"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Document_userId_contentHash_key" ON "Document"("userId", "contentHash");
