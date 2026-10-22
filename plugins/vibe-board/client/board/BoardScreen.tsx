// Main screen: tab 0 is the general board (all projects, colored per project, filterable), then one
// tab per project. Card detail opens beside the board (wide) or replaces it (compact).

import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { CARD_PRIORITIES, type CardColumn, type CardPriority, type CardView } from "../../shared/vibe/contract";
import { useBoardData, useRefresh } from "../common/api";
import { PRIORITY_COLORS, tagColor } from "../common/colors";
import { HostProvider, useHost } from "../common/ctx";
import { Btn, Chip, Muted, TextField } from "../common/ui";
import { CardDetail } from "../detail/CardDetail";
import { ManageModal } from "../presets/manager";
import { useProviderUsage } from "../presets/usage";
import { Board, useIdMap } from "./Board";
import { CardMenu, type MenuAction } from "./CardMenu";
import { NewCardModal } from "./NewCardModal";
import {
  PRIORITY_LABELS,
  errorMessage,
  filterCards,
  groupByColumn,
  projectColor,
  stepNeighbours,
  type DropPlan,
} from "./logic";

const ALL = "all";

export function BoardScreen(props: PluginScreenProps) {
  return (
    <HostProvider
      value={{
        theme: props.theme,
        compact: props.layout.compact,
        openAgent: props.navigation ? (input) => props.navigation?.openAgent(input) : undefined,
      }}
    >
      <BoardContent initialProject={props.params.project} initialCard={props.params.card} />
    </HostProvider>
  );
}

function BoardContent({ initialProject, initialCard }: { initialProject?: string; initialCard?: string }) {
  const { theme, compact } = useHost();
  const toast = useToast();
  const refresh = useRefresh();
  const { api, cards, projects, tags, presets, loading, error } = useBoardData();
  const usage = useProviderUsage();

  const [tab, setTab] = useState<string>(initialProject ?? ALL);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<CardPriority | null>(null);
  const [tagId, setTagId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(initialCard ?? null);
  const [menuCard, setMenuCard] = useState<CardView | null>(null);
  const [newCard, setNewCard] = useState<{ open: boolean; column: "draft" | "todo" }>({
    open: false,
    column: "draft",
  });
  const [manageOpen, setManageOpen] = useState(false);

  const projectIndex = useMemo(() => new Map(projects.map((p, i) => [p.id, i])), [projects]);
  const colorOf = (projectId: string) => {
    const i = projectIndex.get(projectId);
    return i === undefined ? theme.colors.foregroundMuted : projectColor(projects[i]!, i);
  };
  const tagsById = useIdMap(tags);
  const presetsById = useIdMap(presets);

  // A tab pointing at a project that no longer exists falls back to the general board.
  useEffect(() => {
    if (tab !== ALL && projects.length > 0 && !projects.some((p) => p.id === tab || p.prefix === tab)) {
      setTab(ALL);
    }
  }, [projects, tab]);
  const activeProject = tab === ALL ? null : (projects.find((p) => p.id === tab || p.prefix === tab) ?? null);

  const visible = useMemo(
    () =>
      filterCards(cards, {
        projectId: activeProject?.id ?? projectFilter,
        search,
        priority,
        tagId,
      }),
    [cards, activeProject, projectFilter, search, priority, tagId],
  );
  const columns = useMemo(() => groupByColumn(visible), [visible]);
  const openCount = (projectId: string | null) =>
    cards.filter((c) => c.column !== "done" && (!projectId || c.projectId === projectId)).length;

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      refresh();
    }
  };

  const applyDrop = (card: CardView, plan: DropPlan) => {
    if (plan.type === "none") return;
    if (plan.type === "illegal") return toast.error(plan.message);
    if (plan.type === "reorder") {
      return run(() => api.cardsReorder({ card: card.id, afterCard: plan.afterCard, beforeCard: plan.beforeCard }));
    }
    return run(async () => {
      await api.cardsMove({ card: card.id, to: plan.to, actor: "user" });
      if (plan.place) await api.cardsReorder({ card: card.id, ...plan.place });
    });
  };

  const onMenuAction = (card: CardView, action: MenuAction) => {
    if (action.type === "open") return setOpenKey(card.key);
    if (action.type === "archive") return run(() => api.cardsArchive({ card: card.id }));
    if (action.type === "review") {
      return run(async () => {
        await api.cardsRequestReview({ card: card.id });
        toast.show(`已请总 agent 审查 ${card.key}`, { variant: "success" });
      });
    }
    if (action.type === "dispatch") {
      return run(async () => {
        const { session } = await api.cardsDispatch({ card: card.id });
        toast.show(`已派发 ${card.key}（${session.currentProvider}）`, { variant: "success" });
      });
    }
    if (action.type === "move") return applyDrop(card, { type: "move", to: action.to, place: null });
    const place = stepNeighbours(columns[card.column], card.id, action.step);
    if (place) return run(() => api.cardsReorder({ card: card.id, ...place }));
  };

  const detail = openKey ? (
    <CardDetail
      cardKey={openKey}
      api={api}
      projects={projects}
      presets={presets}
      tags={tags}
      usage={usage}
      projectColorOf={colorOf}
      refresh={refresh}
      onClose={() => setOpenKey(null)}
    />
  ) : null;

  const noProjects = !loading && projects.length === 0;

  const board = (
    <View style={{ flex: 1, padding: 12, gap: 10 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
        <Chip label="总看板" selected={tab === ALL} count={openCount(null)} onPress={() => setTab(ALL)} />
        {projects.map((p, i) => (
          <Chip
            key={p.id}
            label={p.name}
            color={projectColor(p, i)}
            selected={activeProject?.id === p.id}
            count={openCount(p.id)}
            onPress={() => setTab(p.id)}
          />
        ))}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextField
          style={{ flex: 1 }}
          value={search}
          onChangeText={setSearch}
          placeholder="搜索编号、标题、描述"
          autoCapitalize="none"
        />
        <Btn icon="Plus" variant="primary" label={compact ? undefined : "新卡片"} onPress={() => setNewCard({ open: true, column: "draft" })} disabled={noProjects} />
        <Btn icon="Settings" label={compact ? undefined : "管理"} onPress={() => setManageOpen(true)} />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, alignItems: "center" }}>
        {tab === ALL ? (
          <>
            <Muted>项目</Muted>
            {projects.map((p, i) => (
              <Chip
                key={p.id}
                label={p.name}
                hint={p.prefix}
                color={projectColor(p, i)}
                selected={projectFilter === p.id}
                onPress={() => setProjectFilter(projectFilter === p.id ? null : p.id)}
              />
            ))}
          </>
        ) : null}
        <Muted>优先级</Muted>
        {CARD_PRIORITIES.filter((p) => p !== "none").map((p) => (
          <Chip
            key={p}
            variant="flag"
            color={PRIORITY_COLORS[p]}
            label={PRIORITY_LABELS[p]}
            selected={priority === p}
            onPress={() => setPriority(priority === p ? null : p)}
          />
        ))}
        <Muted>标签</Muted>
        {tags.map((t) => (
          <Chip
            key={t.id}
            variant="tag"
            color={tagColor(t)}
            label={t.name}
            selected={tagId === t.id}
            onPress={() => setTagId(tagId === t.id ? null : t.id)}
          />
        ))}
      </ScrollView>

      {error ? <Text style={{ color: theme.colors.statusDanger }}>{errorMessage(error)}</Text> : null}
      {noProjects ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <Text style={{ color: theme.colors.foreground }}>还没有项目</Text>
          <Btn variant="primary" icon="Plus" label="创建第一个项目" onPress={() => setManageOpen(true)} />
        </View>
      ) : (
        <Board
          columns={columns}
          colorOf={colorOf}
          projectNameOf={tab === ALL ? (id) => projects.find((p) => p.id === id)?.prefix : undefined}
          tagsById={tagsById}
          presetsById={presetsById}
          onOpen={(c) => setOpenKey(c.key)}
          onMenu={setMenuCard}
          onDrop={applyDrop}
          onAdd={(column: CardColumn) =>
            setNewCard({ open: true, column: column === "todo" ? "todo" : "draft" })
          }
        />
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {compact ? (
        (detail ?? board)
      ) : (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <View style={{ flex: 1 }}>{board}</View>
          {detail ? (
            <View style={{ width: 440, borderLeftWidth: 1, borderLeftColor: theme.colors.border }}>
              {detail}
            </View>
          ) : null}
        </View>
      )}
      <CardMenu
        card={menuCard}
        columnCards={menuCard ? columns[menuCard.column] : []}
        onClose={() => setMenuCard(null)}
        onAction={onMenuAction}
      />
      <NewCardModal
        open={newCard.open}
        onClose={() => setNewCard((s) => ({ ...s, open: false }))}
        api={api}
        projects={projects}
        tags={tags}
        presets={presets}
        usage={usage}
        initialProjectId={activeProject?.id ?? projectFilter ?? null}
        initialColumn={newCard.column}
        refresh={refresh}
        onCreated={() => undefined}
      />
      <ManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        api={api}
        projects={projects}
        presets={presets}
        tags={tags}
        usage={usage}
        refresh={refresh}
      />
    </View>
  );
}
