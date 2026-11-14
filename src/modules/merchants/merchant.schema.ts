import { z } from 'zod';

// PAN format: 5 letters, 4 digits, 1 letter (fictional values only)
export const createMerchantSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  businessType: z.enum(['SOLE_PROPRIETOR', 'PARTNERSHIP', 'PRIVATE_LIMITED']),
  contactEmail: z.string().email(),
  contactPhone: z.string().regex(/^[6-9]\d{9}$/, 'Must be a 10-digit Indian mobile number'),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN format'),
});


// PAN can't be edited after creation, so it is left out
export const updateMerchantSchema = createMerchantSchema.omit({ pan: true }).partial();

export const reviewSchema = z
  .object({
    action: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((d) => d.action === 'APPROVE' || d.reason, {
    message: 'A reason is required for REJECT and REQUEST_CHANGES',
    path: ['reason'],
  });