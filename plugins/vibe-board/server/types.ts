import type {
  PresetEnvironmentKind,
  PresetPermissionMode,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskThreadLiveStatus,
} from "../shared/constants";

export type {
  PresetEnvironmentKind,
  PresetPermissionMode,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskThreadLiveStatus,
};

export type CommentKind = "user" | "agent" | "system";

export interface Folder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  nextTaskNumber: number;
  color: string;
  folderId: string | null;
  linkedBbProjectId: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  number: number;
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  parentTaskId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
}

export interface TaskLabel {
  taskId: string;
  labelId: string;
}

export interface Comment {
  id: string;
  taskId: string;
  kind: CommentKind;
  authorName: string;
  presetName: string | null;
  threadId: string | null;
  body: string;
  notifiedCount: number;
  createdAt: string;
}

export interface Attachment {
  id: string;
  taskId: string | null;
  commentId: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  isImage: boolean;
  createdAt: string;
}

export interface TaskThread {
  id: string;
  taskId: string;
  threadId: string;
  workspaceId: string | null;
  presetName: string;
  title: string;
  liveStatus: TaskThreadLiveStatus;
  attachedAt: string;
  updatedAt: string;
}

export interface Preset {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  serviceTier: string | null;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
  instructions: string;
  builtin: boolean;
  createdAt: string;
}

export interface CreateFolderInput {
  name: string;
  parentFolderId?: string | null;
}

export interface UpdateFolderInput {
  name?: string;
  parentFolderId?: string | null;
}

export interface DeleteFolderResult {
  deleted: boolean;
  movedProjectIds: string[];
  movedFolderIds: string[];
}

export interface CreateProjectInput {
  name: string;
  prefix: string;
  color: string;
  folderId?: string | null;
  linkedBbProjectId?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  prefix?: string;
  color?: string;
  folderId?: string | null;
  linkedBbProjectId?: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  parentTaskId?: string | null;
}

export interface MoveTaskToProjectResult {
  task: Task;
  moved: Array<{ previousKey: string; task: Task }>;
}

export interface ListTasksFilters {
  projectId?: string;
  statuses?: readonly TaskStatus[];
  priorities?: readonly TaskPriority[];
  labelIds?: readonly string[];
  activeOnly?: boolean;
  parentTaskId?: string | null;
  search?: string;
  sort?: TaskSort;
  limit?: number;
  cursor?: string;
}

export interface ListTasksPage {
  tasks: Task[];
  nextCursor: string | null;
}

export interface UpdateTaskPositionInput {
  status: TaskStatus;
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}

export interface CreateLabelInput {
  projectId: string;
  name: string;
  color: string;
}

export interface UpdateLabelInput {
  name?: string;
  color?: string;
}

export interface CreateCommentInput {
  taskId: string;
  kind: CommentKind;
  authorName: string;
  presetName?: string | null;
  threadId?: string | null;
  body: string;
}

export interface UpdateCommentInput {
  notifiedCount: number;
}

export interface CreateAttachmentInput {
  taskId?: string | null;
  commentId?: string | null;
  fileName: string;
  mime: string;
  sizeBytes: number;
  blobPath: string;
  isImage: boolean;
}

export interface UpdateAttachmentInput {
  blobPath: string;
}

export interface UpsertTaskThreadInput {
  taskId: string;
  threadId: string;
  workspaceId?: string | null;
  presetName: string;
  title: string;
  liveStatus: TaskThreadLiveStatus;
}

export interface CreatePresetInput {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  serviceTier: string | null;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  machineId: string | null;
  instructions: string;
  builtin?: boolean;
}

export interface UpdatePresetInput {
  name?: string;
  providerId?: string;
  modelId?: string;
  reasoningLevel?: string;
  serviceTier?: string | null;
  permissionMode?: PresetPermissionMode;
  environmentKind?: PresetEnvironmentKind;
  baseBranch?: string | null;
  machineId?: string | null;
  instructions?: string;
  builtin?: boolean;
}
