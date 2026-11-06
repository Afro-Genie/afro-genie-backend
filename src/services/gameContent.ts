import { z } from 'zod';

const sourceUrl = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'Source URLs must use HTTPS.');

const commonContent = {
  formatVersion: z.literal(1),
  level: z.number().int().min(1).max(100),
  editorialStatus: z.enum(['NOT_AUTHORED', 'REVIEW_REQUIRED', 'APPROVED']).optional(),
  sources: z.array(sourceUrl),
};

const uniqueNonEmptyStrings = (minimum: number) =>
  z.array(z.string().trim().min(1)).min(minimum).refine(
    (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
    'Values must be unique.',
  );

export const lyricGenieContentSchema = z.object({
  ...commonContent,
  answerTitle: z.string().trim().min(1),
  acceptedTitles: uniqueNonEmptyStrings(1),
  artist: z.string().trim().min(1),
  clues: z.array(z.string().trim().min(1)).length(6),
}).superRefine((content, context) => {
  if (!content.acceptedTitles.some((title) => title.toLowerCase() === content.answerTitle.toLowerCase())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acceptedTitles'],
      message: 'Accepted titles must include the answer title.',
    });
  }
  if (content.sources.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'At least one source is required.',
    });
  }
});

export const starSeekerContentSchema = z.object({
  ...commonContent,
  targetArtistId: z.string().trim().min(1),
  targetName: z.string().trim().min(1),
  attributes: z.object({
    name: z.string().trim().min(1),
    country: z.string().trim().min(1),
    region: z.string().trim().min(1),
    genre: z.string().trim().min(1),
    debut: z.number().int(),
    gender: z.string().trim().min(1),
    size: z.number().int().min(1),
  }),
  hints: z.array(z.string().trim().min(1)).length(3),
}).superRefine((content, context) => {
  if (content.attributes.name.toLowerCase() !== content.targetName.toLowerCase()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attributes', 'name'],
      message: 'Artist attributes must describe the target artist.',
    });
  }
  if (content.sources.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'At least one source is required.',
    });
  }
});

const rhythmGroupSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  items: z.array(z.string().trim().min(1)).length(4),
});

export const rhythmGroupsContentSchema = z.object({
  ...commonContent,
  groups: z.array(rhythmGroupSchema).length(4),
}).superRefine((content, context) => {
  const groups = content.groups;
  const groupIds = groups.map(({ id }) => id);
  if (new Set(groupIds).size !== groupIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groups'],
      message: 'Group IDs must be unique.',
    });
  }

  const allItems = groups.flatMap(({ items }) => items);
  if (new Set(allItems.map((item) => item.toLowerCase())).size !== allItems.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['groups'],
      message: 'All 16 board items must be unique.',
    });
  }

  if (content.sources.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'At least one source is required.',
    });
  }
});

const triviaOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
});

const triviaQuestionSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  options: z.array(triviaOptionSchema).length(4),
  correctOptionId: z.string().trim().min(1),
  explanation: z.string().trim().min(1),
  source: sourceUrl,
}).superRefine((question, context) => {
  const optionIds = question.options.map(({ id }) => id);
  const labels = question.options.map(({ label }) => label.toLowerCase());
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Option IDs must be unique.',
    });
  }
  if (new Set(labels).size !== labels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Option labels must be unique.',
    });
  }
  if (!optionIds.includes(question.correctOptionId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['correctOptionId'],
      message: 'The correct option ID must refer to one of the options.',
    });
  }
});

export const dailyBeadsContentSchema = z.object({
  ...commonContent,
  questions: z.array(triviaQuestionSchema).length(5),
}).superRefine((content, context) => {
  const questionIds = content.questions.map(({ id }) => id);
  if (new Set(questionIds).size !== questionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['questions'],
      message: 'Question IDs must be unique.',
    });
  }
  if (content.sources.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sources'],
      message: 'At least one source is required.',
    });
  }
});

export type GameContentType =
  | 'LYRIC_GENIE'
  | 'STAR_SEEKER'
  | 'RHYTHM_GROUPS'
  | 'DAILY_BEADS';

export function parseGameContent(game: GameContentType, content: unknown) {
  switch (game) {
    case 'LYRIC_GENIE':
      return lyricGenieContentSchema.parse(content);
    case 'STAR_SEEKER':
      return starSeekerContentSchema.parse(content);
    case 'RHYTHM_GROUPS':
      return rhythmGroupsContentSchema.parse(content);
    case 'DAILY_BEADS':
      return dailyBeadsContentSchema.parse(content);
    default:
      throw new Error(`Unsupported game content type: ${game satisfies never}`);
  }
}
