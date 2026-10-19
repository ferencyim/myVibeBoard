import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  ISO_DATE_PATTERN,
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
  PROJECT_PREFIX_PATTERN,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  TASK_THREAD_LIVE_STATUSES,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
  ULID_PATTERN,
} from "./constants";

export const idSchema = z.string().regex(ULID_PATTERN, "must be a ULID");
export const nonBlankStringSchema = z.string().trim().min(1, "must not be blank");
export const presetReasoningLevelSchema = nonBlankStringSchema;
export const presetServiceTierSchema = nonBlankStringSchema;
export const presetPermissionModeSchema = z.enum(PRESET_PERMISSION_MODES);
export const presetEnvironmentKindSchema = z.enum(PRESET_ENVIRONMENT_KINDS);
export const nullablePresetTargetSchema = nonBlankStringSchema.nullable();

export const projectPrefixSchema = z
  .string()
  .regex(
    PROJECT_PREFIX_PATTERN,
    "must be uppercase alphanumeric, start with a letter, and contain at most 10 characters",
  );

export const dueDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "must be a valid calendar date in YYYY-MM-DD format");

export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const taskSortSchema = z.enum(TASK_SORTS);

export const folderSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    parentFolderId: idSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();

export const projectSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    prefix: projectPrefixSchema,
    nextTaskNumber: z.number().int().positive(),
    color: z.string(),
    folderId: idSchema.nullable(),
    linkedBbProjectId: nonBlankStringSchema.nullable(),
    createdAt: z.string(),
  })
  .strict();

export const taskSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    number: z.number().int().positive(),
    key: z.string(),
    title: z.string(),
    description: z.string(),
    status: taskStatusSchema,
    priority: taskPrioritySchema,
    dueDate: dueDateSchema.nullable(),
    parentTaskId: idSchema.nullable(),
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    labelIds: z.array(idSchema),
  })
  .strict();

export const labelSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    color: z.string(),
  })
  .strict();

export const commentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    kind: z.enum(["user", "agent", "system"]),
    authorName: z.string(),
    presetName: z.string().nullable(),
    threadId: nonBlankStringSchema.nullable(),
    body: z.string(),
    notifiedCount: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();

export const commentProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .strict();

export const displayCommentSchema = commentSchema
  .extend({
    threadTitle: z.string().nullable(),
    provider: commentProviderSchema.nullable(),
  })
  .strict();

export const attachmentSchema = z
  .object({
    id: idSchema,
    taskId: idSchema.nullable(),
    commentId: idSchema.nullable(),
    fileName: z.string(),
    mime: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    isImage: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export const taskThreadSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    threadId: nonBlankStringSchema,
    workspaceId: nonBlankStringSchema.nullable().optional(),
    presetName: z.string(),
    title: z.string(),
    liveStatus: z.enum(TASK_THREAD_LIVE_STATUSES),
    attachedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const taskPullRequestSchema = z
  .object({
    url: z.string().url(),
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["open", "draft", "merged", "closed"]),
    updatedAt: z.string(),
    threadIds: z.array(nonBlankStringSchema).min(1),
  })
  .strict();

export const presetSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    reasoningLevel: presetReasoningLevelSchema,
    serviceTier: presetServiceTierSchema.nullable(),
    permissionMode: presetPermissionModeSchema,
    environmentKind: presetEnvironmentKindSchema,
    baseBranch: nullablePresetTargetSchema,
    machineId: nullablePresetTargetSchema,
    instructions: z.string(),
    builtin: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export const tasksDomainErrorSchema = z
  .object({
    code: z.enum([
      "task_parent_invalid",
      "subtask_depth_exceeded",
      "subtask_project_mismatch",
      "label_project_mismatch",
      "project_not_empty",
      "project_prefix_conflict",
      "attachment_referenced",
    ]),
    message: z.string(),
  })
  .strict();

export const taskMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }).strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

export const projectMutationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), project: projectSchema }).strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

export const projectDeleteResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), deleted: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

export const attachmentDeleteResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      deleted: z.literal(true),
      attachment: attachmentSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      deleted: z.literal(false),
      attachment: z.null(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: tasksDomainErrorSchema }).strict(),
]);

export const taskLabelsSchema = z
  .array(idSchema)
  .max(100)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "must not contain duplicates",
  );

export const updateTaskInputSchema = z
  .object({
    taskId: idSchema,
    title: nonBlankStringSchema.optional(),
    description: z.string().optional(),
    status: taskStatusSchema.optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: dueDateSchema.nullable().optional(),
    parentTaskId: idSchema.nullable().optional(),
    labelIds: taskLabelsSchema.optional(),
    authorName: nonBlankStringSchema.default("You"),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.status !== undefined ||
      input.priority !== undefined ||
      input.dueDate !== undefined ||
      input.parentTaskId !== undefined ||
      input.labelIds !== undefined,
    { message: "at least one task field must be updated" },
  );

export const updateProjectInputSchema = z
  .object({
    projectId: idSchema,
    name: nonBlankStringSchema.optional(),
    color: nonBlankStringSchema.optional(),
    folderId: idSchema.nullable().optional(),
    linkedBbProjectId: nonBlankStringSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.color !== undefined ||
      input.folderId !== undefined ||
      input.linkedBbProjectId !== undefined,
    { message: "at least one project field must be updated" },
  );

export const updateLabelInputSchema = z
  .object({
    labelId: idSchema,
    name: nonBlankStringSchema.optional(),
    color: nonBlankStringSchema.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.color !== undefined, {
    message: "at least one label field must be updated",
  });

export const updatePresetInputSchema = z
  .object({
    presetId: idSchema,
    name: nonBlankStringSchema.optional(),
    providerId: nonBlankStringSchema.optional(),
    modelId: nonBlankStringSchema.optional(),
    reasoningLevel: presetReasoningLevelSchema.optional(),
    serviceTier: presetServiceTierSchema.nullable().optional(),
    permissionMode: presetPermissionModeSchema.optional(),
    environmentKind: presetEnvironmentKindSchema.optional(),
    baseBranch: nullablePresetTargetSchema.optional(),
    machineId: nullablePresetTargetSchema.optional(),
    instructions: z.string().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.providerId !== undefined ||
      input.modelId !== undefined ||
      input.reasoningLevel !== undefined ||
      input.serviceTier !== undefined ||
      input.permissionMode !== undefined ||
      input.environmentKind !== undefined ||
      input.baseBranch !== undefined ||
      input.machineId !== undefined ||
      input.instructions !== undefined,
    { message: "at least one preset field must be updated" },
  )
  .superRefine((input, ctx) => {
    if (
      input.environmentKind === "project-default" &&
      input.baseBranch !== undefined &&
      input.baseBranch !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseBranch"],
        message: "requires environmentKind new-worktree",
      });
    }
    if (
      input.environmentKind === "project-default" &&
      input.machineId !== undefined &&
      input.machineId !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["machineId"],
        message: "requires environmentKind new-worktree",
      });
    }
  });

// Folder RPCs
export const createFolderRpc = defineRpc({
  name: "tasks.create_folder",
  input: z
    .object({
      name: nonBlankStringSchema,
      parentFolderId: idSchema.nullable().default(null),
    })
    .strict(),
  output: z.object({ folder: folderSchema }).strict(),
});

export const renameFolderRpc = defineRpc({
  name: "tasks.rename_folder",
  input: z.object({ folderId: idSchema, name: nonBlankStringSchema }).strict(),
  output: z.object({ folder: folderSchema }).strict(),
});

export const moveFolderRpc = defineRpc({
  name: "tasks.move_folder",
  input: z
    .object({ folderId: idSchema, parentFolderId: idSchema.nullable() })
    .strict(),
  output: z.object({ folder: folderSchema }).strict(),
});

export const deleteFolderRpc = defineRpc({
  name: "tasks.delete_folder",
  input: z.object({ folderId: idSchema }).strict(),
  output: z
    .object({
      deleted: z.boolean(),
      movedProjectIds: z.array(idSchema),
      movedFolderIds: z.array(idSchema),
    })
    .strict(),
});

export const listFoldersRpc = defineRpc({
  name: "tasks.list_folders",
  input: z.object({}).strict(),
  output: z.object({ folders: z.array(folderSchema) }).strict(),
});

// Project RPCs
export const createProjectRpc = defineRpc({
  name: "tasks.create_project",
  input: z
    .object({
      name: nonBlankStringSchema,
      prefix: projectPrefixSchema,
      color: nonBlankStringSchema,
      folderId: idSchema.nullable().default(null),
      linkedBbProjectId: nonBlankStringSchema.nullable().default(null),
    })
    .strict(),
  output: z.object({ project: projectSchema }).strict(),
});

export const updateProjectRpc = defineRpc({
  name: "tasks.update_project",
  input: updateProjectInputSchema,
  output: z.object({ project: projectSchema }).strict(),
});

export const renameProjectPrefixRpc = defineRpc({
  name: "tasks.rename_project_prefix",
  input: z
    .object({ projectId: idSchema, prefix: projectPrefixSchema })
    .strict(),
  output: projectMutationResultSchema,
});

export const deleteProjectRpc = defineRpc({
  name: "tasks.delete_project",
  input: z
    .object({ projectId: idSchema, force: z.boolean().default(false) })
    .strict(),
  output: projectDeleteResultSchema,
});

export const listProjectsRpc = defineRpc({
  name: "tasks.list_projects",
  input: z.object({ folderId: idSchema.nullable().optional() }).strict(),
  output: z.object({ projects: z.array(projectSchema) }).strict(),
});

export const listPaseoProjectsRpc = defineRpc({
  name: "tasks.list_paseo_projects",
  input: z.object({}).strict(),
  output: z
    .object({
      bbProjects: z.array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            rootPath: z.string().optional(),
            kind: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export const sidebarOpenTaskCountRpc = defineRpc({
  name: "tasks.sidebar_open_task_count",
  input: z.object({}).strict(),
  output: z.object({ openTaskCount: z.number().int().nonnegative() }).strict(),
});

export const sidebarSummaryRpc = defineRpc({
  name: "tasks.sidebar_summary",
  input: z.object({}).strict(),
  output: z
    .object({
      projects: z.array(
        z
          .object({
            projectId: idSchema,
            taskCount: z.number().int().nonnegative(),
            activeAgentCount: z.number().int().nonnegative(),
          })
          .strict(),
      ),
    })
    .strict(),
});

// Task RPCs
export const createTaskRpc = defineRpc({
  name: "tasks.create_task",
  input: z
    .object({
      projectId: idSchema,
      title: nonBlankStringSchema,
      description: z.string().default(""),
      status: taskStatusSchema.default("backlog"),
      priority: taskPrioritySchema.default("none"),
      dueDate: dueDateSchema.nullable().default(null),
      parentTaskId: idSchema.nullable().default(null),
      labelIds: taskLabelsSchema.default([]),
    })
    .strict(),
  output: taskMutationResultSchema,
});

export const getTaskRpc = defineRpc({
  name: "tasks.get_task",
  input: z.object({ taskId: idSchema }).strict(),
  output: z.object({ task: taskSchema.nullable() }).strict(),
});

export const getTaskByKeyRpc = defineRpc({
  name: "tasks.get_task_by_key",
  input: z.object({ taskKey: nonBlankStringSchema }).strict(),
  output: z.object({ task: taskSchema.nullable() }).strict(),
});

export const updateTaskRpc = defineRpc({
  name: "tasks.update_task",
  input: updateTaskInputSchema,
  output: taskMutationResultSchema,
});

export const deleteTaskRpc = defineRpc({
  name: "tasks.delete_task",
  input: z.object({ taskId: idSchema }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const listTasksRpc = defineRpc({
  name: "tasks.list_tasks",
  input: z
    .object({
      projectId: idSchema.optional(),
      statuses: z.array(taskStatusSchema).optional(),
      priorities: z.array(taskPrioritySchema).optional(),
      labelIds: z.array(idSchema).optional(),
      activeOnly: z.boolean().default(false),
      parentTaskId: idSchema.nullable().optional(),
      search: z.string().optional(),
      sort: taskSortSchema.default("manual"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(TASKS_PAGE_MAX_LIMIT)
        .default(TASKS_PAGE_DEFAULT_LIMIT),
      cursor: nonBlankStringSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      tasks: z.array(taskSchema),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export const boardMoveRpc = defineRpc({
  name: "tasks.board_move",
  input: z
    .object({
      taskId: idSchema,
      status: taskStatusSchema,
      beforeTaskId: idSchema.nullable().optional(),
      afterTaskId: idSchema.nullable().optional(),
      authorName: nonBlankStringSchema.default("You"),
    })
    .strict(),
  output: taskMutationResultSchema,
});

export const moveTaskToProjectRpc = defineRpc({
  name: "tasks.move_task_to_project",
  input: z
    .object({
      taskId: idSchema,
      projectId: idSchema,
      authorName: nonBlankStringSchema.default("You"),
    })
    .strict(),
  output: taskMutationResultSchema,
});

// Label RPCs
export const createLabelRpc = defineRpc({
  name: "tasks.create_label",
  input: z
    .object({
      projectId: idSchema,
      name: nonBlankStringSchema,
      color: nonBlankStringSchema,
    })
    .strict(),
  output: z.object({ label: labelSchema }).strict(),
});

export const updateLabelRpc = defineRpc({
  name: "tasks.update_label",
  input: updateLabelInputSchema,
  output: z.object({ label: labelSchema }).strict(),
});

export const deleteLabelRpc = defineRpc({
  name: "tasks.delete_label",
  input: z.object({ labelId: idSchema }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const listLabelsRpc = defineRpc({
  name: "tasks.list_labels",
  input: z.object({ projectId: idSchema }).strict(),
  output: z.object({ labels: z.array(labelSchema) }).strict(),
});

// Comment RPCs
export const createCommentRpc = defineRpc({
  name: "tasks.create_comment",
  input: z
    .object({
      taskId: idSchema,
      body: z.string(),
      notify: z.boolean(),
      allowEmptyBody: z.boolean().default(false),
    })
    .strict()
    .refine((input) => input.allowEmptyBody || input.body.trim().length > 0, {
      path: ["body"],
      message: "Comment body cannot be empty",
    }),
  output: z.object({ comment: commentSchema }).strict(),
});

export const listCommentsRpc = defineRpc({
  name: "tasks.list_comments",
  input: z.object({ taskId: idSchema }).strict(),
  output: z.object({ comments: z.array(displayCommentSchema) }).strict(),
});

// Attachment RPCs
export const listAttachmentsRpc = defineRpc({
  name: "tasks.list_attachments",
  input: z.union([
    z.object({ taskId: idSchema }).strict(),
    z.object({ commentId: idSchema }).strict(),
    z.object({ commentsOfTaskId: idSchema }).strict(),
  ]),
  output: z.object({ attachments: z.array(attachmentSchema) }).strict(),
});

export const uploadAttachmentRpc = defineRpc({
  name: "tasks.upload_attachment",
  input: z
    .object({
      taskId: idSchema.optional(),
      commentId: idSchema.optional(),
      fileName: nonBlankStringSchema,
      mime: z.string().optional(),
      base64: z.string(),
    })
    .strict(),
  output: z.object({ attachment: attachmentSchema }).strict(),
});

export const downloadAttachmentRpc = defineRpc({
  name: "tasks.download_attachment",
  input: z.object({ attachmentId: idSchema }).strict(),
  output: z
    .object({
      attachment: attachmentSchema,
      base64: z.string(),
    })
    .strict(),
});

export const deleteAttachmentRpc = defineRpc({
  name: "tasks.delete_attachment",
  input: z
    .object({
      attachmentId: idSchema,
      removeDescriptionReferences: z.boolean().default(false),
    })
    .strict(),
  output: attachmentDeleteResultSchema,
});

// Task Thread & Delegation RPCs
export const listTaskThreadsRpc = defineRpc({
  name: "tasks.list_task_threads",
  input: z.object({ taskId: idSchema }).strict(),
  output: z.object({ taskThreads: z.array(taskThreadSchema) }).strict(),
});

export const listTaskPullRequestsRpc = defineRpc({
  name: "tasks.list_task_pull_requests",
  input: z.object({ taskId: idSchema }).strict(),
  output: z
    .object({
      pullRequests: z.array(taskPullRequestSchema),
      unavailableThreadIds: z.array(z.string()),
    })
    .strict(),
});

export const delegateTaskRpc = defineRpc({
  name: "tasks.delegate",
  input: z
    .object({
      taskId: idSchema,
      presetId: idSchema,
      extraInstructions: z.string().optional(),
    })
    .strict(),
  output: z
    .object({
      threadId: z.string(),
      workspaceId: z.string().nullable().optional(),
    })
    .strict(),
});

export const attachTaskThreadRpc = defineRpc({
  name: "tasks.task_threads_attach",
  input: z
    .object({
      taskId: idSchema,
      threadId: nonBlankStringSchema,
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
});

export const detachTaskThreadRpc = defineRpc({
  name: "tasks.task_threads_detach",
  input: z
    .object({
      taskId: idSchema,
      threadId: nonBlankStringSchema,
    })
    .strict(),
  output: z.object({ threadId: z.string() }).strict(),
});

export const getAgentTasksRpc = defineRpc({
  name: "tasks.get_agent_tasks",
  input: z.object({ agentId: nonBlankStringSchema }).strict(),
  output: z
    .object({
      tasks: z.array(taskSchema),
    })
    .strict(),
});

export const searchThreadsRpc = defineRpc({
  name: "tasks.search_threads",
  input: z
    .object({
      query: z.string(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  output: z
    .object({
      threads: z.array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            workspaceId: z.string().nullable().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
});

// Preset & Provider Catalog RPCs
export const createPresetRpc = defineRpc({
  name: "tasks.create_preset",
  input: z
    .object({
      name: nonBlankStringSchema,
      providerId: nonBlankStringSchema,
      modelId: nonBlankStringSchema,
      reasoningLevel: presetReasoningLevelSchema,
      serviceTier: presetServiceTierSchema.nullable().default(null),
      permissionMode: presetPermissionModeSchema,
      environmentKind: presetEnvironmentKindSchema.default("project-default"),
      baseBranch: nullablePresetTargetSchema.default(null),
      machineId: nullablePresetTargetSchema.default(null),
      instructions: z.string().default(""),
    })
    .strict()
    .superRefine((input, ctx) => {
      if (
        input.environmentKind === "project-default" &&
        input.baseBranch !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["baseBranch"],
          message: "requires environmentKind new-worktree",
        });
      }
      if (
        input.environmentKind === "project-default" &&
        input.machineId !== null
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["machineId"],
          message: "requires environmentKind new-worktree",
        });
      }
    }),
  output: z.object({ preset: presetSchema }).strict(),
});

export const updatePresetRpc = defineRpc({
  name: "tasks.update_preset",
  input: updatePresetInputSchema,
  output: z.object({ preset: presetSchema }).strict(),
});

export const deletePresetRpc = defineRpc({
  name: "tasks.delete_preset",
  input: z.object({ presetId: idSchema }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const listPresetsRpc = defineRpc({
  name: "tasks.list_presets",
  input: z.object({}).strict(),
  output: z.object({ presets: z.array(presetSchema) }).strict(),
});

export const listProviderCatalogRpc = defineRpc({
  name: "tasks.list_provider_catalog",
  input: z.object({}).strict(),
  output: z
    .object({
      providers: z.array(
        z
          .object({
            id: z.string(),
            available: z.boolean(),
            models: z.array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      ),
    })
    .strict(),
});

export const seedDemoRpc = defineRpc({
  name: "tasks.seed_demo",
  input: z
    .object({
      linkedProjectId: z.string().optional(),
    })
    .strict(),
  output: z
    .object({
      foldersCreated: z.number(),
      projectsCreated: z.number(),
      labelsCreated: z.number(),
      tasksCreated: z.number(),
      commentsCreated: z.number(),
      linkedBbProjectId: z.string().nullable(),
      projects: z.array(
        z
          .object({
            id: z.string(),
            keyPrefix: z.string(),
            name: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
});

// Composer Attachment Source
export const searchTaskAttachmentsRpc = defineRpc({
  name: "tasks.search_attachment_items",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const tasksAttachmentSource = defineAttachmentSource({
  id: "tasks",
  title: "Task",
  icon: "ListTodo",
  pickerTitle: "Attach Task",
  searchPlaceholder: "Search by task key (PROD-1) or title",
  search: searchTaskAttachmentsRpc,
});

// Timeline Renderer Schemas
export const taskCardDataSchema = z.object({
  taskKey: z.string(),
  fallbackTitle: z.string().nullable(),
  valid: z.boolean(),
  phase: z.enum(["streaming", "complete"]),
});

export const taskTextDataSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]),
});

export type Folder = z.infer<typeof folderSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Label = z.infer<typeof labelSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type CommentProvider = z.infer<typeof commentProviderSchema>;
export type DisplayComment = z.infer<typeof displayCommentSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type TaskThread = z.infer<typeof taskThreadSchema>;
export type TaskPullRequest = z.infer<typeof taskPullRequestSchema>;
export type Preset = z.infer<typeof presetSchema>;
export type TasksDomainError = z.infer<typeof tasksDomainErrorSchema>;
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;
export type PaseoProjectOption = z.infer<
  typeof listPaseoProjectsRpc.output
>["bbProjects"][number];
export type SidebarProjectSummary = z.infer<
  typeof sidebarSummaryRpc.output
>["projects"][number];
export type TaskCardData = z.infer<typeof taskCardDataSchema>;
export type TaskTextData = z.infer<typeof taskTextDataSchema>;
