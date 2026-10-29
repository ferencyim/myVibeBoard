import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import { Button, type ButtonVariant } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Switch } from "@/ui/switch";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { StatusIndicator } from "@/ui/status-indicator";
import { ListRow } from "@/ui/list-row";
import { Menu, MenuTrigger, MenuSurface, MenuItem, MenuSeparator } from "@/ui/menu";
import { Dialog, ConfirmDialog } from "@/ui/dialog";
import { Sheet } from "@/ui/sheet";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";

const BUTTON_VARIANTS: ButtonVariant[] = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
];
const STATUSES = ["working", "responded", "unread", "waiting", "failed", "routine"] as const;
const SIZES = ["sm", "md", "base", "lg", "xl", "2xl", "display"] as const;
const SWATCHES = [
  "bgCanvas",
  "bgFrame",
  "bgSidebar",
  "bgSheet",
  "bgGrouped",
  "bgSurface",
  "bgSurfaceRaised",
  "bgControl",
  "bgControlHover",
  "bgControlActive",
  "accent",
  "success",
  "warning",
  "danger",
] as const;
type PreviewOverlay = "dialog" | "confirm" | "sheet" | null;
const SHEET_HEADER = { title: "片层示例" };
const ROW_AVATAR = <Avatar seed="row" name="林" />;
const ROW_BADGE = <Badge label="附件" variant="muted" />;
const IMAGE_SAMPLE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY2Co+f4fjGEMAFEqCcmu3MehAAAAAElFTkSuQmCC";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

function ButtonStates({ variant }: { variant: ButtonVariant }) {
  return (
    <View style={styles.row}>
      <Button variant={variant}>{variant}</Button>
      <Button variant={variant} disabled>
        禁用
      </Button>
      <Button variant={variant} loading>
        处理中
      </Button>
    </View>
  );
}

function PreviewMenu({ onSelect }: { onSelect: (value: string) => void }) {
  const selectNormal = useCallback(() => onSelect("普通菜单项"), [onSelect]);
  const selectDanger = useCallback(() => onSelect("危险菜单项"), [onSelect]);
  return (
    <Menu>
      <MenuTrigger accessibilityLabel="打开示例菜单" style={styles.menuTrigger}>
        <Text style={styles.body}>打开菜单</Text>
      </MenuTrigger>
      <MenuSurface>
        <MenuItem onSelect={selectNormal}>普通菜单项</MenuItem>
        <MenuItem disabled>禁用菜单项</MenuItem>
        <MenuSeparator />
        <MenuItem destructive onSelect={selectDanger}>
          危险菜单项（仅演示）
        </MenuItem>
      </MenuSurface>
    </Menu>
  );
}

function PreviewTooltip() {
  return (
    <Tooltip>
      <TooltipTrigger>
        <Text style={styles.body}>悬停 350ms</Text>
      </TooltipTrigger>
      <TooltipContent>仅 Web 悬停提示</TooltipContent>
    </Tooltip>
  );
}

export function VisualFoundationPreview() {
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState("");
  const [overlay, setOverlay] = useState<PreviewOverlay>(null);
  const [result, setResult] = useState("尚未操作");
  const [pending, setPending] = useState(false);
  const [destructive, setDestructive] = useState(true);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openDialog = useCallback(() => setOverlay("dialog"), []);
  const openConfirm = useCallback(() => setOverlay("confirm"), []);
  const openSheet = useCallback(() => setOverlay("sheet"), []);
  const confirm = useCallback(() => setPending(true), []);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setResult("已确认");
      setPending(false);
      setOverlay(null);
    }, 1600);
    return () => clearTimeout(timer);
  }, [pending]);
  const selectRow = useCallback(() => setResult("普通行"), []);
  const selectActiveRow = useCallback(() => setResult("选中行"), []);
  const selectDisabledRow = useCallback(() => setResult("不应触发"), []);
  const rowSwitch = useMemo(
    () => <Switch accessibilityLabel="设置示例" value={enabled} onValueChange={setEnabled} />,
    [enabled],
  );
  const dialogFooter = useMemo(() => <Button onPress={closeOverlay}>完成</Button>, [closeOverlay]);
  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <Text style={styles.title}>WP-137 视觉基础</Text>
          <Text style={styles.body}>
            仅开发构建。外观跟随现有设置；悬停、Tab
            聚焦和按下可检查交互状态。菜单与弹层按钮仅操作本页示例。
          </Text>
          <Section title="颜色与字号">
            <View style={styles.row}>
              {SWATCHES.map((token) => (
                <View key={token} style={styles.swatch(token)}>
                  <Text style={styles.swatchLabel}>{token}</Text>
                </View>
              ))}
            </View>
            {SIZES.map((size) => (
              <Text key={size} style={styles.typeSample(size)}>
                {size} · 字号与行高 Aa 中文
              </Text>
            ))}
          </Section>
          <Section title="Button：常规 / 禁用 / 处理中">
            {BUTTON_VARIANTS.map((variant) => (
              <ButtonStates key={variant} variant={variant} />
            ))}
            <View style={styles.row}>
              <Button size="xs">xs 24</Button>
              <Button size="sm">sm 32</Button>
              <Button size="default">default 36</Button>
              <Button size="lg">lg 40</Button>
            </View>
            <View style={styles.row}>
              <IconButton label="添加示例" icon={Plus} tooltip="添加示例" />
              <IconButton label="禁用的添加" icon={Plus} disabled />
            </View>
          </Section>
          <Section title="Input / Textarea / Switch">
            <Input
              accessibilityLabel="示例输入"
              placeholder="输入内容以检查光标与焦点"
              onChangeText={setText}
            />
            <Text style={styles.caption}>当前输入：{text}</Text>
            <Input accessibilityLabel="禁用输入" placeholder="禁用输入" editable={false} />
            <Textarea accessibilityLabel="示例多行输入" placeholder="多行内容" />
            <Textarea
              accessibilityLabel="禁用多行输入"
              placeholder="禁用多行输入"
              editable={false}
            />
            <View style={styles.row}>
              <Switch accessibilityLabel="示例开关" value={enabled} onValueChange={setEnabled} />
              <Switch accessibilityLabel="关闭的开关" value={false} />
              <Switch accessibilityLabel="禁用开关开启" value disabled />
              <Switch accessibilityLabel="禁用开关关闭" value={false} disabled />
            </View>
          </Section>
          <Section title="Avatar / Badge / StatusIndicator">
            <View style={styles.row}>
              <Avatar seed="preview-a" name="林" />
              <Avatar seed="preview-b" name="alice" />
              <Avatar seed="preview-c" name="Bot" hue={220} size={48} />
              <Avatar seed="preview-blank" name="" />
              <Avatar seed="preview-image" name="图片" uri={IMAGE_SAMPLE} />
              <Avatar seed="preview-error" name="回退" uri="data:image/png;base64,invalid" />
            </View>
            <View style={styles.row}>
              <Badge label="中性" variant="muted" />
              <Badge label="成功" variant="success" />
              <Badge label="警告" variant="warning" />
              <Badge label="失败" variant="error" />
              <Badge label="小徽章" variant="muted" size="xs" />
            </View>
            <View style={styles.row}>
              {STATUSES.map((status) => (
                <View key={status} style={styles.statusSample}>
                  <StatusIndicator status={status} count={12} />
                  <Text style={styles.caption}>{status}</Text>
                </View>
              ))}
            </View>
          </Section>
          <Section title="ListRow：54 / 设置行 64">
            <ListRow
              title="普通行"
              subtitle="副标题与右侧附件"
              avatar={ROW_AVATAR}
              trailing={ROW_BADGE}
              onPress={selectRow}
            />
            <ListRow title="选中行" subtitle="保持选中状态" selected onPress={selectActiveRow} />
            <ListRow title="禁用行" subtitle="不可操作" disabled onPress={selectDisabledRow} />
            <ListRow
              title="设置行"
              subtitle="最小高度 64"
              variant="settings"
              trailing={rowSwitch}
            />
          </Section>
          <Section title="Menu / Tooltip / Dialog / ConfirmDialog / Sheet">
            <View style={styles.row}>
              <PreviewMenu onSelect={setResult} />
              <PreviewTooltip />
              <Button variant="outline" onPress={openDialog}>
                Dialog
              </Button>
              <Button variant="outline" onPress={openConfirm}>
                ConfirmDialog
              </Button>
              <Button variant="outline" onPress={openSheet}>
                Sheet
              </Button>
            </View>
            <Text accessibilityLiveRegion="polite" style={styles.caption}>
              操作结果：{result}
            </Text>
            <View style={styles.row}>
              <Text style={styles.caption}>危险确认样式；确认后模拟处理中 1.6 秒</Text>
              <Switch
                accessibilityLabel="危险确认样式"
                value={destructive}
                onValueChange={setDestructive}
              />
            </View>
          </Section>
        </View>
      </ScrollView>
      <Dialog
        visible={overlay === "dialog"}
        title="普通对话框"
        onClose={closeOverlay}
        footer={dialogFooter}
      >
        <Text style={styles.body}>检查圆角、标题、边线、键盘 Escape 与关闭后的焦点。</Text>
      </Dialog>
      <ConfirmDialog
        visible={overlay === "confirm"}
        title="确认演示操作"
        message="此操作只改变本页提示文字。"
        onClose={closeOverlay}
        onConfirm={confirm}
        destructive={destructive}
        pending={pending}
      />
      <Sheet visible={overlay === "sheet"} header={SHEET_HEADER} onClose={closeOverlay}>
        <View style={styles.section}>
          <Text style={styles.body}>Android / 窄屏底部片层，桌面复用自适应容器。</Text>
          <Button onPress={closeOverlay}>关闭片层</Button>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, backgroundColor: theme.colors.bgCanvas },
  scrollContent: { flexGrow: 1 },
  content: {
    padding: theme.spacing[6],
    gap: theme.spacing[6],
    width: "100%",
    maxWidth: 1000,
    alignSelf: "center",
  },
  section: { gap: theme.spacing[3] },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  title: {
    color: theme.colors.textPrimary,
    fontFamily: theme.fontFamily.ui,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "600",
  },
  heading: {
    color: theme.colors.textPrimary,
    fontFamily: theme.fontFamily.ui,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "600",
  },
  body: {
    color: theme.colors.textPrimary,
    fontFamily: theme.fontFamily.ui,
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    color: theme.colors.textMuted,
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    lineHeight: 16,
  },
  statusSample: { gap: theme.spacing[2], alignItems: "center", minWidth: 80 },
  menuTrigger: {
    padding: theme.spacing[2],
    borderRadius: 8,
    backgroundColor: theme.colors.bgControl,
    minHeight: 32,
    justifyContent: "center",
  },
  swatch: (token: (typeof SWATCHES)[number]) => ({
    backgroundColor: theme.colors[token],
    borderColor: theme.colors.borderStrong,
    borderWidth: 1,
    borderRadius: 8,
    width: 140,
    height: 54,
    justifyContent: "flex-end",
  }),
  swatchLabel: {
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.bgCanvas,
    fontSize: 12,
    lineHeight: 16,
  },
  typeSample: (size: (typeof SIZES)[number]) => ({
    color: theme.colors.textPrimary,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize[size],
    lineHeight: theme.lineHeight[size],
  }),
}));
