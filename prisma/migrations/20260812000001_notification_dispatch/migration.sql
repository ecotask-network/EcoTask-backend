-- Notification outbound delivery channels
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "webhook_url" TEXT;

ALTER TABLE "notifications" ADD COLUMN "channel" TEXT;
ALTER TABLE "notifications" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN "delivery_error" TEXT;
