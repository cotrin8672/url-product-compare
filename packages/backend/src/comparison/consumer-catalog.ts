export type ConsumerListingCondition = "new" | "used" | "refurbished" | "unknown";

type ConsumerField = Readonly<{
  id: string;
  label: string;
  unit: string;
  kind: "number" | "text" | "boolean";
  filter: "min" | "max" | "required" | null;
  minimum: number;
  maximum: number;
  presets: readonly number[];
}>;

type ConsumerCategoryAxis = Readonly<{
  id: string;
  label: string;
  lowerIsBetter: boolean;
  weight: number;
}>;

type ConsumerFieldExtraction =
  | Readonly<{ kind: "numberPattern"; pattern: string }>
  | Readonly<{ kind: "resolution" }>
  | Readonly<{ kind: "booleanFlag"; labels: string }>
  | Readonly<{ kind: "attribute" }>
  | Readonly<{ kind: "labeledText"; labels: string }>;

export type ConsumerFieldDefinition = ConsumerField &
  Readonly<{ extraction?: ConsumerFieldExtraction; jevChoiceEligible?: boolean }>;

export type ConsumerCategoryDefinition = Readonly<{
  id: string;
  label: string;
  description: string;
  providerBindings?: Readonly<
    Record<string, Readonly<{ genreId: string; keyword: string; searchExcludeKeyword?: string }>>
  >;
  mainFields: readonly string[];
  fields: readonly ConsumerFieldDefinition[];
  axes: readonly ConsumerCategoryAxis[];
  allowUnknownCondition?: boolean;
}>;

export type ConsumerCatalogCategory = Readonly<{
  id: string;
  label: string;
  description: string;
  fields: readonly ConsumerField[];
  mainFields: readonly string[];
  axes: readonly ConsumerCategoryAxis[];
  allowUnknownCondition?: boolean;
}>;

export type ConsumerCatalog = Readonly<{
  categories: readonly ConsumerCategoryDefinition[];
  category: (input: unknown) => ConsumerCategoryDefinition | null;
  publicCategories: () => readonly ConsumerCatalogCategory[];
}>;

const categoryIdPattern = /^[a-z][a-z0-9_-]{0,63}$/;

function parseConsumerCategoryId(input: unknown): string | null {
  return typeof input === "string" && categoryIdPattern.test(input) ? input : null;
}

const field = (
  id: string,
  label: string,
  unit: string,
  minimum: number,
  maximum: number,
  filter: ConsumerField["filter"],
  presets: readonly number[] = [],
  extraction?: ConsumerFieldExtraction,
  jevChoiceEligible = false,
): ConsumerFieldDefinition =>
  Object.freeze({
    id,
    label,
    unit,
    kind: "number",
    minimum,
    maximum,
    filter,
    presets: Object.freeze(presets),
    ...(extraction === undefined ? {} : { extraction }),
    ...(jevChoiceEligible ? { jevChoiceEligible: true } : {}),
  });

const textField = (id: string, label: string, labels: string): ConsumerFieldDefinition =>
  Object.freeze({
    ...field(id, label, "", 0, 0, null),
    kind: "text",
    extraction: Object.freeze({ kind: "labeledText", labels }),
  });

const flag = (id: string, label: string, labels: string): ConsumerFieldDefinition =>
  Object.freeze({
    ...field(id, label, "", 0, 0, "required"),
    kind: "boolean",
    extraction: Object.freeze({ kind: "booleanFlag", labels }),
  });

const ram = field(
  "ramGb",
  "メモリ（同時に作業する余裕）",
  "GB",
  1,
  512,
  "min",
  [4, 8, 16, 32],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:^|[^a-z])(?:メモリ(?:容量)?|RAM|memory)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(GB|TB)(?![a-z])",
  }),
  true,
);
const storage = field(
  "storageGb",
  "保存容量",
  "GB",
  1,
  32768,
  "min",
  [64, 128, 256, 512, 1000],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:^|[^a-z])(?:ストレージ(?:容量)?|保存容量|記憶装置|内蔵容量|SSD|HDD|ROM|storage)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(GB|TB)(?=SSD(?:[^a-z]|$)|HDD(?:[^a-z]|$)|[^a-z]|$)",
  }),
  true,
);
const screen = field(
  "screenInches",
  "画面サイズ",
  "インチ",
  3,
  120,
  "min",
  [10, 13, 15, 24, 27, 32, 43, 55, 65],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:画面サイズ|パネルサイズ|ディスプレイサイズ|対角サイズ|screen\\s*size)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(インチ|型|inch(?:es)?)",
  }),
);
const width = field(
  "widthPx",
  "画面の横の画素数",
  "px",
  320,
  16384,
  "min",
  [1920, 2560, 3840],
  Object.freeze({ kind: "resolution" }),
);
const height = field(
  "heightPx",
  "画面の縦の画素数",
  "px",
  240,
  8640,
  null,
  [],
  Object.freeze({ kind: "resolution" }),
);
const weight = field(
  "weightG",
  "重さ",
  "g",
  1,
  100000,
  "max",
  [200, 500, 1000, 1500, 2000],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:本体重量|本体質量|重量|質量|重さ|weight)\\s*[:：]?\\s*(?:約\\s*)?(\\d+(?:\\.\\d+)?)\\s*(kg|g)",
  }),
);
const cpu = textField("cpu", "CPU", "CPU|プロセッサー|チップ|processor|SoC");
const gpu = textField(
  "gpu",
  "GPU",
  "GPU(?:モデル|型番)?|グラフィックス(?:タイプ)?|グラフィック(?:タイプ)?|graphics",
);
const os = textField("os", "OS", "OS|オペレーティングシステム");
const cpuCores = field(
  "cpuCores",
  "CPUコア数",
  "コア",
  1,
  256,
  "min",
  [4, 8, 16],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:CPU\\s*(?:コア数|cores?)|プロセッサー?\\s*コア数|コア数|number\\s*of\\s*cores)\\s*[:：]?\\s*(\\d+)(?![\\d.])(?:\\s*(?:コア|cores?))?(?=[\\s,，、/〜~・]|$)",
  }),
);
const cpuThreads = field(
  "cpuThreads",
  "CPUスレッド数",
  "スレッド",
  1,
  1024,
  "min",
  [8, 16, 32],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:CPU\\s*(?:スレッド数|threads?)|プロセッサー?\\s*スレッド数|スレッド数|number\\s*of\\s*threads)\\s*[:：]?\\s*(\\d+)(?![\\d.])(?:\\s*(?:スレッド|threads?))?(?=[\\s,，、/〜~・]|$)",
  }),
);
const gpuVram = field(
  "gpuVramGb",
  "GPUメモリ容量",
  "GB",
  0,
  512,
  "min",
  [4, 8, 16],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:GPU\\s*(?:メモリ(?:容量)?|memory)|(?:専用)?(?:ビデオ|グラフィック(?:ス)?)メモリ(?:容量)?|VRAM|video\\s*memory)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(GB|TB)(?![a-z])",
  }),
);
const cpuBaseClock = field(
  "cpuBaseGhz",
  "CPU基本周波数",
  "GHz",
  0.1,
  20,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:CPU\\s*(?:基本周波数|基本クロック|ベースクロック)|(?:プロセッサー|processor)\\s*(?:基本周波数|ベースクロック)?|ベースクロック)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(GHz)(?![a-z])",
  }),
);
const cpuBoostClock = field(
  "cpuBoostGhz",
  "CPU最大周波数",
  "GHz",
  0.1,
  20,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:CPU\\s*(?:最大周波数|最大クロック|ブーストクロック)|(?:CPU|プロセッサー|processor)(?:(?!GPU|グラフィック|メモリ|RAM|NPU|OS|ディスプレイ)[^;\\n]){0,100}?最大\\s*(?:(?:動作)?周波数|クロック|ブースト(?:[・\\s]*クロック)?)?)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(GHz)(?![a-z])",
  }),
);
const cpuCache = field(
  "cpuCacheMb",
  "CPUキャッシュ",
  "MB",
  0.1,
  1024,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:CPU\\s*キャッシュ|プロセッサー\\s*キャッシュ|L3\\s*キャッシュ|3次キャッシュ)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(MB)(?![a-z])",
  }),
);
const gpuBoostClock = field(
  "gpuBoostMhz",
  "GPU最大周波数",
  "MHz",
  1,
  20000,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "GPU\\s*(?:最大周波数|最大クロック|ブーストクロック)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(MHz|GHz)(?![a-z])",
  }),
);
const gpuPower = field(
  "gpuPowerW",
  "GPU消費電力",
  "W",
  1,
  2000,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:GPU\\s*(?:消費電力|TGP)|(?:最大)?TGP|グラフィック(?:ス)?消費電力)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(W)(?![a-z])",
  }),
);
const ramSpeed = field(
  "ramSpeedMtps",
  "メモリ速度",
  "MT/s",
  100,
  20000,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:(?:メモリ(?:速度|転送速度)|RAM\\s*speed)\\s*[:：]?\\s*(?=\\d+(?:\\.\\d+)?\\s*MT/s)|(?:LP)?DDR[3-6]X?\\s*[- ]?)(\\d+(?:\\.\\d+)?)\\s*(MT/s)?(?=[\\s;，、,/()・]|$)",
  }),
);
const hdmiOutputs = field(
  "hdmiOutputPorts",
  "HDMI出力数",
  "個",
  0,
  16,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "HDMI\\s*(?:(?:出力)?(?:端子|ポート)(?:数)?\\s*[:：]?\\s*|(?:\\d+(?:\\.\\d+)?\\s*)?[×x]\\s*)(\\d+)(?![\\d.])(?:\\s*(?:個|基|ポート))?(?=[\\s,，、/〜~・;]|$)",
  }),
);
const srgb = field(
  "srgbPercent",
  "sRGB色域",
  "%",
  1,
  200,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern: "sRGB\\s*(?:色域|カバー率|coverage)?\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(%)(?![\\d.])",
  }),
);
const usbAPorts = field(
  "usbAPorts",
  "USB-Aポート数",
  "個",
  0,
  32,
  "min",
  [1, 2, 4],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "USB\\s*(?:Type\\s*)?[- ]?A\\s*(?:ポート数|端子数|ports?)\\s*[:：]?\\s*(\\d+)(?![\\d.])(?:\\s*(?:個|基|ポート|ports?))?(?=[\\s,，、/〜~・]|$)",
  }),
);
const usbCPorts = field(
  "usbCPorts",
  "USB-Cポート数",
  "個",
  0,
  32,
  "min",
  [1, 2, 4],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "USB\\s*(?:Type\\s*)?[- ]?C\\s*(?:ポート数|端子数|ports?)\\s*[:：]?\\s*(\\d+)(?![\\d.])(?:\\s*(?:個|基|ポート|ports?))?(?=[\\s,，、/〜~・]|$)",
  }),
);
const wifi = textField(
  "wifiVersion",
  "Wi-Fi規格",
  "Wi[- ]?Fi(?:\\s*(?:規格|バージョン|version))?|無線LAN(?:規格)?",
);
const bluetooth = textField(
  "bluetoothVersion",
  "Bluetooth",
  "Bluetooth(?:\\s*(?:規格|バージョン|version))?",
);
const wiredLan = flag("wiredLan", "有線LAN", "有線LAN|wired\\s*LAN|ethernet");
const brightness = field(
  "brightnessNits",
  "画面の明るさ",
  "nit",
  1,
  10000,
  "min",
  [250, 300, 500],
  Object.freeze({
    kind: "numberPattern",
    pattern: "(?:画面輝度|輝度|brightness)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(nits?)(?![a-z])",
  }),
);
const bodyWidth = field(
  "widthMm",
  "本体の幅",
  "mm",
  1,
  2000,
  "max",
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern: "(?:本体幅|幅|width)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mm)(?![a-z])",
  }),
);
const bodyHeight = field(
  "heightMm",
  "本体の高さ・厚さ",
  "mm",
  1,
  2000,
  "max",
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:本体高さ|本体厚さ|高さ|厚さ|height)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mm)(?![a-z])",
  }),
);
const bodyDepth = field(
  "depthMm",
  "本体の奥行き",
  "mm",
  1,
  2000,
  "max",
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern: "(?:本体奥行き?|奥行き?|depth)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mm)(?![a-z])",
  }),
);
const batteryHours = field(
  "batteryHours",
  "公称バッテリー時間",
  "時間",
  0.1,
  100,
  null,
  [],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:バッテリー駆動時間|バッテリー時間|battery\\s*life)\\s*[:：]?\\s*(?:約\\s*)?(\\d+(?:\\.\\d+)?)\\s*(時間|hours?|h)",
  }),
);
const battery = field(
  "batteryMah",
  "バッテリー容量",
  "mAh",
  100,
  50000,
  "min",
  [4000, 5000, 8000],
  Object.freeze({
    kind: "numberPattern",
    pattern: "(?:バッテリー(?:容量)?|電池容量|battery)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(mAh)",
  }),
);
const batteryWh = field(
  "batteryWh",
  "バッテリー容量",
  "Wh",
  1,
  500,
  "min",
  [40, 60, 90],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:バッテリー(?:容量)?|電池容量|battery(?:\\s*capacity)?)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(Whr?)(?![a-z])",
  }),
);
const refresh = field(
  "refreshHz",
  "画面の更新回数",
  "Hz",
  24,
  600,
  "min",
  [60, 120, 144],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "(?:最大リフレッシュレート|リフレッシュレート|refresh\\s*rate)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*(Hz)",
  }),
);
const hdmi = field(
  "hdmiPorts",
  "HDMI入力の数",
  "個",
  0,
  16,
  "min",
  [1, 2, 3, 4],
  Object.freeze({
    kind: "numberPattern",
    pattern: "HDMI\\s*(?:端子数|ポート数|入力数)\\s*[:：]?\\s*(\\d+)(?![\\d.])",
  }),
);
const usbCPower = field(
  "usbCPowerW",
  "USB-C給電",
  "W",
  0,
  240,
  "min",
  [65, 90],
  Object.freeze({
    kind: "numberPattern",
    pattern:
      "USB\\s*(?:Type\\s*)?[- ]?C\\s*(?:給電|電力供給|PD|power\\s*delivery)\\s*[:：]?\\s*(?:最大|max\\.?\\s*)?(\\d+(?:\\.\\d+)?)\\s*(W)",
  }),
);

const priceAxis = Object.freeze({
  id: "price",
  label: "価格",
  lowerIsBetter: true,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const memoryAxis = Object.freeze({
  id: "ramGb",
  label: "メモリ",
  lowerIsBetter: false,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const storageAxis = Object.freeze({
  id: "storageGb",
  label: "保存容量",
  lowerIsBetter: false,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const weightAxis = Object.freeze({
  id: "weightG",
  label: "軽さ",
  lowerIsBetter: true,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const screenAxis = Object.freeze({
  id: "screenInches",
  label: "画面サイズ",
  lowerIsBetter: false,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const resolutionAxis = Object.freeze({
  id: "widthPx",
  label: "解像度",
  lowerIsBetter: false,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const refreshAxis = Object.freeze({
  id: "refreshHz",
  label: "更新回数",
  lowerIsBetter: false,
  weight: 1,
} satisfies ConsumerCategoryAxis);
const fieldAxis = (
  definition: ConsumerFieldDefinition,
  lowerIsBetter = false,
  label = definition.label,
): ConsumerCategoryAxis => Object.freeze({ id: definition.id, label, lowerIsBetter, weight: 1 });

const defaultCategoryEntries: readonly ConsumerCategoryDefinition[] = Object.freeze(
  [
    Object.freeze({
      id: "laptop",
      label: "ノートPC",
      description: "仕事、学習、持ち運びに",
      providerBindings: {
        rakuten: {
          genreId: "100040",
          keyword: "ノートパソコン",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["cpu", "gpu", "ramGb", "storageGb", "weightG", "batteryHours"]),
      fields: Object.freeze([
        cpu,
        gpu,
        os,
        ram,
        storage,
        screen,
        width,
        height,
        refresh,
        brightness,
        weight,
        batteryHours,
        batteryWh,
        cpuCores,
        cpuThreads,
        gpuVram,
        usbAPorts,
        usbCPorts,
        wifi,
        bluetooth,
        wiredLan,
        bodyWidth,
        bodyHeight,
        bodyDepth,
        cpuBaseClock,
        cpuBoostClock,
        cpuCache,
        gpuBoostClock,
        gpuPower,
        ramSpeed,
        hdmiOutputs,
        srgb,
      ]),
      axes: Object.freeze([
        priceAxis,
        memoryAxis,
        storageAxis,
        weightAxis,
        fieldAxis(batteryHours, false, "駆動時間"),
        resolutionAxis,
        refreshAxis,
        fieldAxis(gpuVram, false, "GPUメモリ"),
        fieldAxis(cpuCores, false, "CPUコア"),
        fieldAxis(cpuThreads, false, "スレッド"),
        fieldAxis(usbAPorts, false, "USB-A"),
        fieldAxis(usbCPorts, false, "USB-C"),
        fieldAxis(brightness, false, "明るさ"),
        fieldAxis(batteryWh, false, "電池容量"),
        fieldAxis(bodyHeight, true, "薄さ"),
        fieldAxis(cpuBaseClock, false, "CPU基本周波数"),
        fieldAxis(cpuBoostClock, false, "CPU最大周波数"),
        fieldAxis(cpuCache, false, "CPUキャッシュ"),
        fieldAxis(gpuBoostClock, false, "GPU最大周波数"),
        fieldAxis(gpuPower, true, "GPU消費電力"),
        fieldAxis(ramSpeed, false, "メモリ速度"),
        fieldAxis(hdmiOutputs, false, "HDMI出力数"),
        fieldAxis(srgb, false, "sRGB色域"),
      ]),
    }),
    Object.freeze({
      id: "desktop",
      label: "デスクトップPC",
      description: "自宅で使うパソコンに",
      providerBindings: {
        rakuten: {
          genreId: "211368",
          keyword: "デスクトップ パソコン",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["cpu", "gpu", "ramGb", "storageGb", "gpuVramGb", "cpuCores"]),
      fields: Object.freeze([
        cpu,
        gpu,
        os,
        ram,
        storage,
        gpuVram,
        cpuCores,
        cpuThreads,
        usbAPorts,
        usbCPorts,
        wifi,
        bluetooth,
        wiredLan,
        flag("displayIncluded", "画面が付属", "画面付属|ディスプレイ付属|display included"),
        screen,
        width,
        height,
        refresh,
        brightness,
        weight,
        bodyWidth,
        bodyHeight,
        bodyDepth,
        cpuBaseClock,
        cpuBoostClock,
        cpuCache,
        gpuBoostClock,
        gpuPower,
        ramSpeed,
        hdmiOutputs,
        srgb,
      ]),
      axes: Object.freeze([
        priceAxis,
        memoryAxis,
        storageAxis,
        fieldAxis(gpuVram, false, "GPUメモリ"),
        fieldAxis(cpuCores, false, "CPUコア"),
        fieldAxis(usbAPorts, false, "USB-A"),
        fieldAxis(usbCPorts, false, "USB-C"),
        fieldAxis(cpuThreads, false, "スレッド"),
        resolutionAxis,
        refreshAxis,
        fieldAxis(brightness, false, "明るさ"),
        weightAxis,
        fieldAxis(bodyWidth, true, "幅"),
        fieldAxis(bodyHeight, true, "高さ"),
        fieldAxis(bodyDepth, true, "奥行"),
        fieldAxis(cpuBaseClock, false, "CPU基本周波数"),
        fieldAxis(cpuBoostClock, false, "CPU最大周波数"),
        fieldAxis(cpuCache, false, "CPUキャッシュ"),
        fieldAxis(gpuBoostClock, false, "GPU最大周波数"),
        fieldAxis(gpuPower, true, "GPU消費電力"),
        fieldAxis(ramSpeed, false, "メモリ速度"),
        fieldAxis(hdmiOutputs, false, "HDMI出力数"),
        fieldAxis(srgb, false, "sRGB色域"),
      ]),
    }),
    Object.freeze({
      id: "tablet",
      label: "タブレット",
      description: "動画、読書、学習に",
      providerBindings: {
        rakuten: {
          genreId: "560029",
          keyword: "タブレット",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["storageGb", "screenInches", "weightG"]),
      fields: Object.freeze([
        cpu,
        os,
        ram,
        storage,
        screen,
        width,
        height,
        weight,
        battery,
        flag("cellular", "モバイル通信対応", "モバイル通信|携帯回線|cellular"),
      ]),
      axes: Object.freeze([priceAxis, memoryAxis, storageAxis, weightAxis]),
    }),
    Object.freeze({
      id: "smartphone",
      label: "スマートフォン",
      description: "毎日使うスマホの買い替えに",
      providerBindings: {
        rakuten: {
          genreId: "560202",
          keyword: "スマートフォン",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["storageGb", "weightG", "simFree"]),
      fields: Object.freeze([
        cpu,
        os,
        ram,
        storage,
        screen,
        weight,
        battery,
        flag("simFree", "SIMフリー", "SIMフリー|SIMロック解除|SIM free"),
        textField("waterResistance", "防水・防じん等級", "防水・防じん等級|防水防塵|防水等級"),
      ]),
      axes: Object.freeze([priceAxis, memoryAxis, storageAxis, weightAxis]),
    }),
    Object.freeze({
      id: "television",
      label: "テレビ",
      description: "リビングや寝室での視聴に",
      providerBindings: {
        rakuten: {
          genreId: "563843",
          keyword: "テレビ",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["screenInches", "widthPx", "refreshHz"]),
      fields: Object.freeze([
        screen,
        width,
        height,
        refresh,
        hdmi,
        weight,
        flag("smartTv", "ネット動画対応", "ネット動画|スマートTV|smart TV"),
        flag("recording", "USB録画対応", "USB録画|外付けHDD録画"),
      ]),
      axes: Object.freeze([priceAxis, screenAxis, resolutionAxis, refreshAxis]),
    }),
    Object.freeze({
      id: "monitor",
      label: "モニター",
      description: "パソコンの画面を広く快適に",
      providerBindings: {
        rakuten: {
          genreId: "110105",
          keyword: "モニター",
          searchExcludeKeyword: "中古 再生品 整備済 展示品 新古品",
        },
      },
      mainFields: Object.freeze(["screenInches", "widthPx", "refreshHz", "usbCPowerW"]),
      fields: Object.freeze([
        screen,
        width,
        height,
        refresh,
        hdmi,
        usbCPower,
        flag("usbCVideo", "USB-C映像入力", "USB[- ]?C映像入力|USB[- ]?C映像対応"),
        flag("heightAdjustable", "高さ調整", "高さ調整|昇降機能|height adjustment"),
      ]),
      axes: Object.freeze([priceAxis, screenAxis, resolutionAxis, refreshAxis]),
    }),
  ].map((category) =>
    Object.freeze({
      ...category,
      fields: Object.freeze(category.fields),
      axes: Object.freeze(category.axes),
      mainFields: Object.freeze(category.mainFields),
    }),
  ),
);

export function toPublicCategory(category: ConsumerCategoryDefinition): ConsumerCatalogCategory {
  return Object.freeze({
    id: category.id,
    label: category.label,
    description: category.description,
    mainFields: category.mainFields,
    axes: category.axes,
    ...(category.allowUnknownCondition === undefined
      ? {}
      : { allowUnknownCondition: category.allowUnknownCondition }),
    fields: Object.freeze(
      category.fields.map((fieldDefinition) =>
        Object.freeze({
          id: fieldDefinition.id,
          label: fieldDefinition.label,
          unit: fieldDefinition.unit,
          kind: fieldDefinition.kind,
          filter: fieldDefinition.filter,
          minimum: fieldDefinition.minimum,
          maximum: fieldDefinition.maximum,
          presets: fieldDefinition.presets,
        }),
      ),
    ),
  });
}

export function buildConsumerCatalog(
  entries: readonly ConsumerCategoryDefinition[],
): ConsumerCatalog {
  const ids = new Set<string>();
  for (const category of entries) {
    if (parseConsumerCategoryId(category.id) === null || ids.has(category.id)) {
      throw new Error(`Invalid or duplicate consumer category: ${category.id}`);
    }
    ids.add(category.id);
    const fields = new Map(category.fields.map((definition) => [definition.id, definition]));
    if (
      fields.size !== category.fields.length ||
      category.label.trim().length === 0 ||
      (category.allowUnknownCondition !== undefined &&
        typeof category.allowUnknownCondition !== "boolean")
    ) {
      throw new Error(`Invalid consumer fields: ${category.id}`);
    }
    for (const definition of category.fields) {
      if (
        !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(definition.id) ||
        definition.id === "price" ||
        definition.label.trim().length === 0 ||
        !Number.isFinite(definition.minimum) ||
        !Number.isFinite(definition.maximum) ||
        definition.minimum > definition.maximum ||
        (definition.kind === "number"
          ? ![null, "min", "max"].includes(definition.filter)
          : definition.kind === "boolean"
            ? ![null, "required"].includes(definition.filter)
            : definition.filter !== null) ||
        new Set(definition.presets).size !== definition.presets.length ||
        definition.presets.some(
          (value) =>
            definition.kind !== "number" ||
            !Number.isFinite(value) ||
            value < definition.minimum ||
            value > definition.maximum,
        )
      ) {
        throw new Error(`Invalid consumer field: ${category.id}.${definition.id}`);
      }
      const extraction = definition.extraction;
      if (extraction !== undefined) {
        const kind =
          extraction.kind === "booleanFlag"
            ? "boolean"
            : extraction.kind === "labeledText" || extraction.kind === "attribute"
              ? "text"
              : "number";
        if (kind !== definition.kind) {
          throw new Error(`Invalid consumer extraction: ${category.id}.${definition.id}`);
        }
        if (extraction.kind !== "resolution" && extraction.kind !== "attribute") {
          new RegExp(
            extraction.kind === "numberPattern" ? extraction.pattern : extraction.labels,
            "gi",
          );
        }
      }
    }
    if (
      new Set(category.mainFields).size !== category.mainFields.length ||
      category.mainFields.some((id) => !fields.has(id)) ||
      new Set(category.axes.map((axis) => axis.id)).size !== category.axes.length ||
      category.axes.some(
        (axis) =>
          (axis.id === "price" ? !axis.lowerIsBetter : fields.get(axis.id)?.kind !== "number") ||
          typeof axis.lowerIsBetter !== "boolean" ||
          axis.label.trim().length === 0 ||
          !Number.isFinite(axis.weight) ||
          axis.weight <= 0,
      )
    ) {
      throw new Error(`Invalid consumer references or axes: ${category.id}`);
    }
    for (const [provider, binding] of Object.entries(category.providerBindings ?? {})) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(provider) ||
        binding.genreId.trim().length === 0 ||
        binding.keyword.trim().length === 0
      ) {
        throw new Error(`Invalid consumer provider binding: ${category.id}.${provider}`);
      }
    }
  }
  const categories = Object.freeze(
    entries.map((category) =>
      Object.freeze({
        ...category,
        fields: Object.freeze(
          category.fields.map((definition) =>
            Object.freeze({
              ...definition,
              presets: Object.freeze([...definition.presets]),
              ...(definition.extraction === undefined
                ? {}
                : { extraction: Object.freeze({ ...definition.extraction }) }),
            }),
          ),
        ),
        axes: Object.freeze(category.axes.map((axis) => Object.freeze({ ...axis }))),
        mainFields: Object.freeze([...category.mainFields]),
        ...(category.providerBindings === undefined
          ? {}
          : {
              providerBindings: Object.freeze(
                Object.fromEntries(
                  Object.entries(category.providerBindings).map(([id, binding]) => [
                    id,
                    Object.freeze({ ...binding }),
                  ]),
                ),
              ),
            }),
      }),
    ),
  );
  return Object.freeze({
    categories,
    category(input: unknown): ConsumerCategoryDefinition | null {
      const id = parseConsumerCategoryId(input);
      return id === null ? null : (categories.find((entry) => entry.id === id) ?? null);
    },
    publicCategories(): readonly ConsumerCatalogCategory[] {
      return Object.freeze(categories.map((category) => toPublicCategory(category)));
    },
  });
}

export const defaultConsumerCatalog: ConsumerCatalog = buildConsumerCatalog(defaultCategoryEntries);

export const consumerCatalogCategories: readonly ConsumerCategoryDefinition[] =
  defaultConsumerCatalog.categories;

export function consumerCategoryDefinition(input: unknown): ConsumerCategoryDefinition | null {
  return defaultConsumerCatalog.category(input);
}

export function publicConsumerCatalog(): readonly ConsumerCatalogCategory[] {
  return defaultConsumerCatalog.publicCategories();
}

const usedEvidence = /中古|\bused\b|ジャンク|訳あり/iu;
const refurbishedEvidence = /(?:整備済(?:み)?|再生品|リファービッシュ|refurbished|認定整備)/iu;
const newEvidence = /新品|\bbrand\s*new\b|\bnew\s*item\b/iu;
const ambiguousNewOld =
  /(?:新古品|新品同様|未開封中古|店舗展示|展示品|アウトレット|\bnew[\s-]+old[\s-]+stock\b)/iu;
const negatedNew =
  /新品\s*(?:(?:では|で|じゃ)\s*)?(?:ありません|ございません|ない|無い|なし)|\bnot\s+(?:brand\s*)?new\b/iu;

/** Explicit title/description evidence only; absence of used markers does not imply new. */
export function readConsumerListingCondition(
  title: string,
  description: string,
): ConsumerListingCondition {
  const text = `${title}\n${description}`.normalize("NFKC");
  if (refurbishedEvidence.test(text)) {
    return "refurbished";
  }
  if (ambiguousNewOld.test(text)) {
    return "unknown";
  }
  if (usedEvidence.test(text)) {
    return "used";
  }
  if (negatedNew.test(text)) {
    return "unknown";
  }
  if (newEvidence.test(text)) {
    return "new";
  }
  return "unknown";
}

export function consumerListingConditionEligible(
  condition: ConsumerListingCondition,
  category?: Pick<ConsumerCategoryDefinition, "allowUnknownCondition">,
): boolean {
  return (
    condition === "new" || (condition === "unknown" && category?.allowUnknownCondition === true)
  );
}

export function readFieldNumberPattern(definition: ConsumerFieldDefinition): string | null {
  if (definition.extraction?.kind === "numberPattern") {
    return definition.extraction.pattern;
  }
  return null;
}

export function readFieldFlagLabels(definition: ConsumerFieldDefinition): string | null {
  if (definition.extraction?.kind === "booleanFlag") {
    return definition.extraction.labels;
  }
  return null;
}

export function readFieldTextLabels(definition: ConsumerFieldDefinition): string | null {
  if (definition.extraction?.kind === "labeledText") {
    return definition.extraction.labels;
  }
  return null;
}
