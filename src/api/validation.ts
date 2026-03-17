import { z } from "zod";

export const addressParam = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{1,64}$/, "Invalid Aptos address format"),
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

export const burnRateQuery = z.object({
  bucket: z.enum(["hour", "day", "week", "month"]).default("day"),
});
