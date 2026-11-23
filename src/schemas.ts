import { z } from 'zod'
import type { Endpoint } from './contract.js'

const budgetPatch = z
  .object({
    tokens: z.number().int().min(5000).max(400000),
    modelCalls: z.number().int().min(3).max(80),
    toolCalls: z.number().int().min(0).max(60),
    clarifications: z.number().int().min(0).max(12),
    specialistCalls: z.number().int().min(0).max(20),
  })
  .partial()

export const schemas = {
  state: z.object({ experimentId: z.string().max(120).optional(), runIds: z.array(z.string().max(160)).max(4).optional() }),
  consult: z.object({
    opening: z.string().min(1).max(4000),
    conditions: z.array(z.enum(['A', 'B'])).min(1).max(2),
    budget: budgetPatch.optional(),
  }),
  answer: z.object({ runId: z.string().max(160), text: z.string().min(1).max(4000), facts: z.array(z.string().max(60)).max(10).optional() }),
  experiment: z.object({
    name: z.string().max(60),
    scenarioIds: z.array(z.string().max(40)).min(1).max(60),
    repeats: z.number().int().min(1).max(5),
    seed: z.number().int().min(0).max(2 ** 31),
    studentMode: z.enum(['simulated', 'manual']),
    autoGrade: z.boolean(),
    budget: budgetPatch.optional(),
  }),
  stop: z.object({ runId: z.string().max(160).optional() }),
  grade: z.object({ experimentId: z.string().max(120), force: z.boolean().optional() }),
  analysis: z.object({ experimentId: z.string().max(120) }),
  exportBlind: z.object({ experimentId: z.string().max(120) }),
  exportRuns: z.object({ experimentId: z.string().max(120) }),
  resume: z.object({ experimentId: z.string().max(120), autoGrade: z.boolean().optional() }),
  importHuman: z.object({
    experimentId: z.string().max(120),
    scores: z
      .array(
        z.object({
          blindId: z.string().max(40),
          rater: z.string().max(40),
          items: z.array(z.object({ id: z.string().max(20), score: z.number().min(0).max(1) })).max(40),
        }),
      )
      .max(2000),
  }),
} satisfies Record<Endpoint, z.ZodTypeAny>

