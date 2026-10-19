import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  PRESET_PERMISSION_MODES,
  PRIORITY_LABELS,
  PROJECT_COLORS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type PresetEnvironmentKind,
  type PresetPermissionMode,
  type TaskPriority,
  type TaskStatus,
} from "../shared/constants";
import {
  createFolderRpc,
  createLabelRpc,
  createPresetRpc,
  createProjectRpc,
  createTaskRpc,
  deleteFolderRpc,
  deleteLabelRpc,
  deletePresetRpc,
  deleteProjectRpc,
  listFoldersRpc,
  listLabelsRpc,
  listPaseoProjectsRpc,
  listPresetsRpc,
  listProjectsRpc,
  listProviderCatalogRpc,
  updateProjectRpc,
  type Project,
} from "../shared/contract";
import { LabelPill, ProjectDot } from "./badges";

export function NewTaskModal({
  open,
  onOpenChange,
  defaultProjectId,
  defaultStatus = "todo",
  theme,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProjectId: string | null;
  defaultStatus?: TaskStatus;
  theme: PluginTheme;
  onCreated?: (taskKey: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const listProjects = useRpc(listProjectsRpc);
  const listLabels = useRpc(listLabelsRpc);
  const createTask = useRpc(createTaskRpc);

  const projectsQuery = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: () => listProjects({}),
    enabled: open,
  });
  const projects = projectsQuery.data?.projects ?? [];

  const [projectId, setProjectId] = useState<string | null>(defaultProjectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>(defaultStatus);
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (defaultProjectId) {
      setProjectId(defaultProjectId);
    } else if (!projectId && projects.length > 0) {
      setProjectId(projects[0]!.id);
    }
  }, [defaultProjectId, projects, projectId]);

  useEffect(() => {
    setStatus(defaultStatus);
  }, [defaultStatus]);

  const labelsQuery = useQuery({
    queryKey: ["tasks", "labels", projectId],
    queryFn: () => listLabels({ projectId: projectId! }),
    enabled: open && Boolean(projectId),
  });
  const labels = labelsQuery.data?.labels ?? [];

  async function handleCreate() {
    if (!projectId) {
      toast.error("Create a project first");
      return;
    }
    if (!title.trim()) {
      toast.error("Task title is required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await createTask({
        projectId,
        title: title.trim(),
        description,
        status,
        priority,
        dueDate: dueDate.trim() ? dueDate.trim() : null,
        labelIds: selectedLabelIds,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setTitle("");
      setDescription("");
      setDueDate("");
      setSelectedLabelIds([]);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.show(`Created ${res.task.key}`, { variant: "success" });
      onOpenChange(false);
      onCreated?.(res.task.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="New Task"
      icon={<Icon name="Plus" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content>
        <View style={{ gap: 14 }}>
          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              PROJECT
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {projects.map((p) => {
                const active = p.id === projectId;
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    onPress={() => {
                      setProjectId(p.id);
                      setSelectedLabelIds([]);
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <ProjectDot color={p.color} size={8} />
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 12,
                        fontWeight: active ? "700" : "500",
                      }}
                    >
                      {p.prefix} · {p.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              TITLE
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What needs to be done?"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 9,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontSize: 14,
              }}
            />
          </View>

          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              DESCRIPTION
            </Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              multiline
              placeholder="Markdown context, acceptance criteria, or notes…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: 84,
                paddingHorizontal: 12,
                paddingVertical: 9,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontSize: 13,
                textAlignVertical: "top",
              }}
            />
          </View>

          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              STATUS
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {TASK_STATUSES.map((s) => {
                const active = status === s;
                return (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    onPress={() => setStatus(s)}
                    style={{
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 999,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: active ? "700" : "500",
                      }}
                    >
                      {STATUS_LABELS[s]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              PRIORITY
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {TASK_PRIORITIES.map((p) => {
                const active = priority === p;
                return (
                  <Pressable
                    key={p}
                    accessibilityRole="button"
                    onPress={() => setPriority(p)}
                    style={{
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 7,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: active ? "700" : "500",
                      }}
                    >
                      {PRIORITY_LABELS[p]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {labels.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontWeight: "600",
                }}
              >
                LABELS
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {labels.map((l) => {
                  const selected = selectedLabelIds.includes(l.id);
                  return (
                    <Pressable
                      key={l.id}
                      accessibilityRole="button"
                      onPress={() =>
                        setSelectedLabelIds((prev) =>
                          prev.includes(l.id)
                            ? prev.filter((id) => id !== l.id)
                            : [...prev, l.id],
                        )
                      }
                      style={{ opacity: selected ? 1 : 0.45 }}
                    >
                      <LabelPill name={l.name} color={l.color} theme={theme} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              DUE DATE (OPTIONAL, YYYY-MM-DD)
            </Text>
            <TextInput
              value={dueDate}
              onChangeText={setDueDate}
              placeholder="2026-10-31"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontSize: 13,
              }}
            />
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={submitting}
            onPress={() => void handleCreate()}
            style={{
              paddingVertical: 11,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
              alignItems: "center",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            <Text
              style={{
                color: theme.colors.accentForeground,
                fontSize: 14,
                fontWeight: "700",
              }}
            >
              {submitting ? "Creating…" : "Create Task"}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function ManageModal({
  open,
  onOpenChange,
  initialTab = "projects",
  theme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "projects" | "presets";
  theme: PluginTheme;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [tab, setTab] = useState<"projects" | "presets">(initialTab);
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const listProjects = useRpc(listProjectsRpc);
  const createProject = useRpc(createProjectRpc);
  const updateProject = useRpc(updateProjectRpc);
  const deleteProject = useRpc(deleteProjectRpc);
  const listFolders = useRpc(listFoldersRpc);
  const createFolder = useRpc(createFolderRpc);
  const deleteFolder = useRpc(deleteFolderRpc);
  const listLabels = useRpc(listLabelsRpc);
  const createLabel = useRpc(createLabelRpc);
  const deleteLabel = useRpc(deleteLabelRpc);
  const listPaseoProjects = useRpc(listPaseoProjectsRpc);
  const listPresets = useRpc(listPresetsRpc);
  const createPreset = useRpc(createPresetRpc);
  const deletePreset = useRpc(deletePresetRpc);
  const listProviderCatalog = useRpc(listProviderCatalogRpc);

  const projectsQuery = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: () => listProjects({}),
    enabled: open,
  });
  const foldersQuery = useQuery({
    queryKey: ["tasks", "folders"],
    queryFn: () => listFolders({}),
    enabled: open,
  });
  const paseoProjectsQuery = useQuery({
    queryKey: ["tasks", "paseoProjects"],
    queryFn: () => listPaseoProjects({}),
    enabled: open,
  });
  const presetsQuery = useQuery({
    queryKey: ["tasks", "presets"],
    queryFn: () => listPresets({}),
    enabled: open,
  });
  const providerCatalogQuery = useQuery({
    queryKey: ["tasks", "providerCatalog"],
    queryFn: () => listProviderCatalog({}),
    enabled: open && tab === "presets",
  });

  const projects = projectsQuery.data?.projects ?? [];
  const folders = foldersQuery.data?.folders ?? [];
  const paseoProjects = paseoProjectsQuery.data?.bbProjects ?? [];
  const presets = presetsQuery.data?.presets ?? [];
  const providerCatalog = providerCatalogQuery.data?.providers ?? [];

  // Project creation form state
  const [projName, setProjName] = useState("");
  const [projPrefix, setProjPrefix] = useState("");
  const [projColor, setProjColor] = useState<string>("blue");
  const [projFolderId, setProjFolderId] = useState<string | null>(null);
  const [projLinkedId, setProjLinkedId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  // Selected project for label management
  const [selectedProjForLabels, setSelectedProjForLabels] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!selectedProjForLabels && projects.length > 0) {
      setSelectedProjForLabels(projects[0]!.id);
    }
  }, [projects, selectedProjForLabels]);

  const labelsQuery = useQuery({
    queryKey: ["tasks", "labels", selectedProjForLabels],
    queryFn: () => listLabels({ projectId: selectedProjForLabels! }),
    enabled: open && Boolean(selectedProjForLabels),
  });
  const projectLabels = labelsQuery.data?.labels ?? [];
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState<string>("blue");

  // Preset creation form state
  const [presetName, setPresetName] = useState("");
  const [presetProvider, setPresetProvider] = useState("codex");
  const [presetModel, setPresetModel] = useState("gpt-5.4");
  const [presetReasoning, setPresetReasoning] = useState("high");
  const [presetPermission, setPresetPermission] =
    useState<PresetPermissionMode>("auto");
  const [presetEnvironment, setPresetEnvironment] =
    useState<PresetEnvironmentKind>("new-worktree");
  const [presetBaseBranch, setPresetBaseBranch] = useState("");
  const [presetInstructions, setPresetInstructions] = useState("");

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  async function handleCreateProject() {
    if (!projName.trim()) {
      toast.error("Project name is required");
      return;
    }
    const derivedPrefix =
      projPrefix.trim().toUpperCase() ||
      projName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6) ||
      "PROJ";
    try {
      const res = await createProject({
        name: projName.trim(),
        prefix: derivedPrefix,
        color: projColor,
        folderId: projFolderId,
        linkedBbProjectId: projLinkedId,
      });
      setProjName("");
      setProjPrefix("");
      invalidateAll();
      toast.show(`Created project ${res.project.prefix}`, {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLinkProject(
    project: Project,
    nextPaseoProjectId: string | null,
  ) {
    try {
      await updateProject({
        projectId: project.id,
        linkedBbProjectId: nextPaseoProjectId,
      });
      invalidateAll();
      toast.show(`Updated ${project.prefix} Paseo project link`, {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleCreatePreset() {
    if (!presetName.trim() || !presetProvider.trim() || !presetModel.trim()) {
      toast.error("Preset name, provider, and model are required");
      return;
    }
    try {
      const res = await createPreset({
        name: presetName.trim(),
        providerId: presetProvider.trim(),
        modelId: presetModel.trim(),
        reasoningLevel: presetReasoning.trim() || "high",
        serviceTier: null,
        permissionMode: presetPermission,
        environmentKind: presetEnvironment,
        baseBranch:
          presetEnvironment === "new-worktree" && presetBaseBranch.trim()
            ? presetBaseBranch.trim()
            : null,
        machineId: null,
        instructions: presetInstructions,
      });
      setPresetName("");
      setPresetInstructions("");
      invalidateAll();
      toast.show(`Created preset ${res.preset.name}`, { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Modal
      title="Manage Tasks & Presets"
      icon={<Icon name="Settings" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content>
        <View style={{ gap: 16 }}>
          {/* Tab Switcher */}
          <View
            style={{
              flexDirection: "row",
              gap: 8,
              padding: 4,
              borderRadius: 10,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => setTab("projects")}
              style={{
                flex: 1,
                paddingVertical: 7,
                borderRadius: 7,
                backgroundColor:
                  tab === "projects" ? theme.colors.surface0 : "transparent",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  fontWeight: tab === "projects" ? "700" : "500",
                }}
              >
                Projects, Folders & Labels
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTab("presets")}
              style={{
                flex: 1,
                paddingVertical: 7,
                borderRadius: 7,
                backgroundColor:
                  tab === "presets" ? theme.colors.surface0 : "transparent",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  fontWeight: tab === "presets" ? "700" : "500",
                }}
              >
                Delegation Presets ({presets.length})
              </Text>
            </Pressable>
          </View>

          {tab === "projects" ? (
            <View style={{ gap: 16 }}>
              {/* Existing Projects & Paseo Links */}
              <View style={{ gap: 8 }}>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  TRACKER PROJECTS ({projects.length})
                </Text>
                {projects.map((p) => (
                  <View
                    key={p.id}
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      gap: 8,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <ProjectDot color={p.color} size={10} />
                        <Text
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 13,
                            fontWeight: "700",
                          }}
                        >
                          {p.prefix} · {p.name}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        onPress={async () => {
                          const res = await deleteProject({
                            projectId: p.id,
                            force: true,
                          });
                          if (!res.ok) {
                            toast.error(res.error.message);
                            return;
                          }
                          invalidateAll();
                          toast.show(`Deleted project ${p.prefix}`, {
                            variant: "info",
                          });
                        }}
                        style={{
                          paddingHorizontal: 7,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor: theme.colors.surface1,
                        }}
                      >
                        <Icon
                          name="Trash2"
                          size={12}
                          color={theme.colors.statusDanger}
                        />
                      </Pressable>
                    </View>

                    {/* Link Paseo Project */}
                    <View style={{ gap: 4 }}>
                      <Text
                        style={{
                          color: theme.colors.foregroundMuted,
                          fontSize: 11,
                        }}
                      >
                        Linked Paseo Project (for worker delegation):
                      </Text>
                      <View
                        style={{
                          flexDirection: "row",
                          flexWrap: "wrap",
                          gap: 6,
                        }}
                      >
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void handleLinkProject(p, null)}
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor:
                              p.linkedBbProjectId === null
                                ? theme.colors.accent
                                : theme.colors.surface1,
                          }}
                        >
                          <Text
                            style={{
                              color:
                                p.linkedBbProjectId === null
                                  ? theme.colors.accentForeground
                                  : theme.colors.foregroundMuted,
                              fontSize: 11,
                            }}
                          >
                            None
                          </Text>
                        </Pressable>
                        {paseoProjects.map((pp) => {
                          const active = p.linkedBbProjectId === pp.id;
                          return (
                            <Pressable
                              key={pp.id}
                              accessibilityRole="button"
                              onPress={() => void handleLinkProject(p, pp.id)}
                              style={{
                                paddingHorizontal: 8,
                                paddingVertical: 4,
                                borderRadius: 6,
                                backgroundColor: active
                                  ? theme.colors.accent
                                  : theme.colors.surface1,
                              }}
                            >
                              <Text
                                style={{
                                  color: active
                                    ? theme.colors.accentForeground
                                    : theme.colors.foreground,
                                  fontSize: 11,
                                  fontWeight: active ? "700" : "400",
                                }}
                              >
                                {pp.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                ))}
              </View>

              {/* Create Project */}
              <View
                style={{
                  padding: 12,
                  borderRadius: 10,
                  backgroundColor: theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  gap: 10,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  New Tracker Project
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={projName}
                    onChangeText={setProjName}
                    placeholder="Project name (e.g. Product)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      flex: 2,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 13,
                    }}
                  />
                  <TextInput
                    value={projPrefix}
                    onChangeText={setProjPrefix}
                    placeholder="PREFIX (PROD)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      flex: 1,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 13,
                    }}
                  />
                </View>

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {PROJECT_COLORS.map((color) => (
                    <Pressable
                      key={color}
                      accessibilityRole="button"
                      onPress={() => setProjColor(color)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 5,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor:
                          projColor === color
                            ? theme.colors.accent
                            : theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <ProjectDot color={color} size={8} />
                      <Text
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 11,
                        }}
                      >
                        {color}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {folders.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setProjFolderId(null)}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor:
                          projFolderId === null
                            ? theme.colors.accent
                            : theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            projFolderId === null
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                          fontSize: 11,
                        }}
                      >
                        No folder
                      </Text>
                    </Pressable>
                    {folders.map((f) => (
                      <Pressable
                        key={f.id}
                        accessibilityRole="button"
                        onPress={() => setProjFolderId(f.id)}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor:
                            projFolderId === f.id
                              ? theme.colors.accent
                              : theme.colors.surface2,
                        }}
                      >
                        <Text
                          style={{
                            color:
                              projFolderId === f.id
                                ? theme.colors.accentForeground
                                : theme.colors.foreground,
                            fontSize: 11,
                          }}
                        >
                          {f.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                {paseoProjects.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {paseoProjects.map((pp) => (
                      <Pressable
                        key={pp.id}
                        accessibilityRole="button"
                        onPress={() =>
                          setProjLinkedId((prev) =>
                            prev === pp.id ? null : pp.id,
                          )
                        }
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor:
                            projLinkedId === pp.id
                              ? theme.colors.accent
                              : theme.colors.surface2,
                        }}
                      >
                        <Text
                          style={{
                            color:
                              projLinkedId === pp.id
                                ? theme.colors.accentForeground
                                : theme.colors.foreground,
                            fontSize: 11,
                          }}
                        >
                          Link: {pp.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}

                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleCreateProject()}
                  style={{
                    paddingVertical: 9,
                    borderRadius: 8,
                    backgroundColor: theme.colors.accent,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.accentForeground,
                      fontSize: 13,
                      fontWeight: "700",
                    }}
                  >
                    Create Project
                  </Text>
                </Pressable>
              </View>

              {/* Folders */}
              <View
                style={{
                  padding: 12,
                  borderRadius: 10,
                  backgroundColor: theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  gap: 8,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  Folders ({folders.length})
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {folders.map((f) => (
                    <View
                      key={f.id}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{ color: theme.colors.foreground, fontSize: 12 }}
                      >
                        {f.name}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={async () => {
                          await deleteFolder({ folderId: f.id });
                          invalidateAll();
                        }}
                      >
                        <Icon
                          name="X"
                          size={12}
                          color={theme.colors.foregroundMuted}
                        />
                      </Pressable>
                    </View>
                  ))}
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={newFolderName}
                    onChangeText={setNewFolderName}
                    placeholder="New folder name…"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      flex: 1,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 12,
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={async () => {
                      if (!newFolderName.trim()) return;
                      await createFolder({ name: newFolderName.trim() });
                      setNewFolderName("");
                      invalidateAll();
                    }}
                    style={{
                      paddingHorizontal: 12,
                      justifyContent: "center",
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 12,
                        fontWeight: "600",
                      }}
                    >
                      + Folder
                    </Text>
                  </Pressable>
                </View>
              </View>

              {/* Project Labels */}
              {projects.length > 0 ? (
                <View
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    gap: 8,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 13,
                      fontWeight: "700",
                    }}
                  >
                    Project Labels
                  </Text>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
                  >
                    {projects.map((p) => (
                      <Pressable
                        key={p.id}
                        accessibilityRole="button"
                        onPress={() => setSelectedProjForLabels(p.id)}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor:
                            selectedProjForLabels === p.id
                              ? theme.colors.accent
                              : theme.colors.surface2,
                        }}
                      >
                        <Text
                          style={{
                            color:
                              selectedProjForLabels === p.id
                                ? theme.colors.accentForeground
                                : theme.colors.foreground,
                            fontSize: 11,
                          }}
                        >
                          {p.prefix}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
                  >
                    {projectLabels.map((l) => (
                      <Pressable
                        key={l.id}
                        accessibilityRole="button"
                        onPress={async () => {
                          await deleteLabel({ labelId: l.id });
                          invalidateAll();
                        }}
                      >
                        <LabelPill
                          name={`${l.name} ×`}
                          color={l.color}
                          theme={theme}
                        />
                      </Pressable>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <TextInput
                      value={newLabelName}
                      onChangeText={setNewLabelName}
                      placeholder="Label name…"
                      placeholderTextColor={theme.colors.foregroundMuted}
                      style={{
                        flex: 1,
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderRadius: 8,
                        backgroundColor: theme.colors.surface2,
                        color: theme.colors.foreground,
                        fontSize: 12,
                      }}
                    />
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        const idx = PROJECT_COLORS.indexOf(
                          newLabelColor as (typeof PROJECT_COLORS)[number],
                        );
                        setNewLabelColor(
                          PROJECT_COLORS[(idx + 1) % PROJECT_COLORS.length]!,
                        );
                      }}
                      style={{
                        paddingHorizontal: 10,
                        justifyContent: "center",
                        borderRadius: 8,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <ProjectDot color={newLabelColor} size={10} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={async () => {
                        if (!selectedProjForLabels || !newLabelName.trim())
                          return;
                        await createLabel({
                          projectId: selectedProjForLabels,
                          name: newLabelName.trim(),
                          color: newLabelColor,
                        });
                        setNewLabelName("");
                        invalidateAll();
                      }}
                      style={{
                        paddingHorizontal: 12,
                        justifyContent: "center",
                        borderRadius: 8,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 12,
                          fontWeight: "600",
                        }}
                      >
                        + Label
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          ) : (
            /* Presets Tab */
            <View style={{ gap: 14 }}>
              {presets.map((preset) => (
                <View
                  key={preset.id}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    gap: 4,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 13,
                        fontWeight: "700",
                      }}
                    >
                      {preset.name}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={async () => {
                        await deletePreset({ presetId: preset.id });
                        invalidateAll();
                      }}
                    >
                      <Icon
                        name="Trash2"
                        size={13}
                        color={theme.colors.statusDanger}
                      />
                    </Pressable>
                  </View>
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 11,
                    }}
                  >
                    {preset.providerId}/{preset.modelId} · reasoning:{" "}
                    {preset.reasoningLevel} · {preset.permissionMode} ·{" "}
                    {preset.environmentKind === "new-worktree"
                      ? `worktree${preset.baseBranch ? ` (${preset.baseBranch})` : ""}`
                      : "project-default"}
                  </Text>
                  {preset.instructions ? (
                    <Text
                      numberOfLines={2}
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      {preset.instructions}
                    </Text>
                  ) : null}
                </View>
              ))}

              <View
                style={{
                  padding: 12,
                  borderRadius: 10,
                  backgroundColor: theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  gap: 10,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  New Execution Preset
                </Text>

                <TextInput
                  value={presetName}
                  onChangeText={setPresetName}
                  placeholder="Preset name (e.g. Codex · High · Worktree)"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    color: theme.colors.foreground,
                    fontSize: 13,
                  }}
                />

                {providerCatalog.length > 0 ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {providerCatalog
                      .filter((p) => p.available)
                      .map((p) => (
                        <Pressable
                          key={p.id}
                          accessibilityRole="button"
                          onPress={() => {
                            setPresetProvider(p.id);
                            if (p.models[0]) {
                              setPresetModel(p.models[0].id);
                            }
                          }}
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor:
                              presetProvider === p.id
                                ? theme.colors.accent
                                : theme.colors.surface2,
                          }}
                        >
                          <Text
                            style={{
                              color:
                                presetProvider === p.id
                                  ? theme.colors.accentForeground
                                  : theme.colors.foreground,
                              fontSize: 11,
                            }}
                          >
                            {p.id}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                ) : null}

                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TextInput
                    value={presetProvider}
                    onChangeText={setPresetProvider}
                    placeholder="Provider (codex, claude, opencode)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      flex: 1,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 12,
                    }}
                  />
                  <TextInput
                    value={presetModel}
                    onChangeText={setPresetModel}
                    placeholder="Model ID (e.g. gpt-5.4)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      flex: 2,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 12,
                    }}
                  />
                </View>

                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {(["low", "medium", "high"] as const).map((level) => (
                    <Pressable
                      key={level}
                      accessibilityRole="button"
                      onPress={() => setPresetReasoning(level)}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor:
                          presetReasoning === level
                            ? theme.colors.accent
                            : theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            presetReasoning === level
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                          fontSize: 11,
                        }}
                      >
                        Reasoning: {level}
                      </Text>
                    </Pressable>
                  ))}
                  {PRESET_PERMISSION_MODES.map((mode) => (
                    <Pressable
                      key={mode}
                      accessibilityRole="button"
                      onPress={() => setPresetPermission(mode)}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor:
                          presetPermission === mode
                            ? theme.colors.accent
                            : theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            presetPermission === mode
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                          fontSize: 11,
                        }}
                      >
                        {mode}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <View style={{ flexDirection: "row", gap: 6 }}>
                  {(
                    [
                      ["project-default", "Project Default Checkout"],
                      ["new-worktree", "Isolated Git Worktree"],
                    ] as const
                  ).map(([kind, label]) => (
                    <Pressable
                      key={kind}
                      accessibilityRole="button"
                      onPress={() => setPresetEnvironment(kind)}
                      style={{
                        flex: 1,
                        paddingVertical: 6,
                        borderRadius: 6,
                        alignItems: "center",
                        backgroundColor:
                          presetEnvironment === kind
                            ? theme.colors.accent
                            : theme.colors.surface2,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            presetEnvironment === kind
                              ? theme.colors.accentForeground
                              : theme.colors.foreground,
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {presetEnvironment === "new-worktree" ? (
                  <TextInput
                    value={presetBaseBranch}
                    onChangeText={setPresetBaseBranch}
                    placeholder="Optional base branch (e.g. main)"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                      color: theme.colors.foreground,
                      fontSize: 12,
                    }}
                  />
                ) : null}

                <TextInput
                  value={presetInstructions}
                  onChangeText={setPresetInstructions}
                  multiline
                  placeholder="Reusable worker instructions…"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    minHeight: 60,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                    color: theme.colors.foreground,
                    fontSize: 12,
                    textAlignVertical: "top",
                  }}
                />

                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleCreatePreset()}
                  style={{
                    paddingVertical: 9,
                    borderRadius: 8,
                    backgroundColor: theme.colors.accent,
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.accentForeground,
                      fontSize: 13,
                      fontWeight: "700",
                    }}
                  >
                    Create Preset
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
