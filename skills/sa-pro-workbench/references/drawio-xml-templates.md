# Draw.io XML Templates Reference

This reference provides concrete draw.io XML code templates for each diagram type. Use these as the base when generating `.drawio` files.

## General draw.io XML Structure

```xml
<mxfile host="Claude" modified="2026-06-02T00:00:00.000Z" agent="Claude Code" version="24.0.0">
  <diagram name="Page-1" id="Page-1">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- All shapes go here as mxCell elements -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

## Common Shape Styles

### 圆角矩形 (Rounded Rectangle) - 最常用组件节点
```xml
<mxCell id="x" value="节点文本" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#E3F2FD;strokeColor=#1E88E5;fontSize=13;fontStyle=1;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="160" height="50" as="geometry" />
</mxCell>
```

### 矩形 (Rectangle) - 标准节点
```xml
<mxCell id="x" value="节点文本" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#333333;fontSize=12;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="160" height="50" as="geometry" />
</mxCell>
```

### 菱形 (Rhombus) - 判断/决策节点
```xml
<mxCell id="x" value="条件?" style="rhombus;whiteSpace=wrap;html=1;fillColor=#FFF9C4;strokeColor=#F9A825;fontSize=12;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="100" height="80" as="geometry" />
</mxCell>
```

### 椭圆 (Ellipse) - 开始/结束
```xml
<mxCell id="x" value="开始" style="ellipse;whiteSpace=wrap;html=1;fillColor=#C8E6C9;strokeColor=#388E3C;fontSize=14;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="120" height="60" as="geometry" />
</mxCell>
```

### 圆柱体 (Cylinder) - 数据库/数据存储
```xml
<mxCell id="x" value="MySQL" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#F3E5F5;strokeColor=#7B1FA2;fontSize=12;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="100" height="80" as="geometry" />
</mxCell>
```

### 泳道容器 (Swimlane) - 角色/分层
```xml
<mxCell id="x" value="泳道标题" style="swimlane;whiteSpace=wrap;html=1;fillColor=#E8EAF6;strokeColor=#3F51B5;fontSize=14;fontStyle=1;startSize=30;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="800" height="200" as="geometry" />
</mxCell>
```

### 分组容器 (Group Container) - 架构层/系统边界
```xml
<mxCell id="x" value="容器标签" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#E3F2FD;strokeColor=#1E88E5;fontSize=14;fontStyle=1;dashed=1;dashPattern=5 5;verticalAlign=top;spacingTop=5;opacity=40;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="500" height="300" as="geometry" />
</mxCell>
```

### 连线 (Edge/Connector)
```xml
<!-- 直线箭头 -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#666666;strokeWidth=1.5;endArrow=classic;fontSize=11;" edge="1" parent="1" source="src_id" target="tgt_id">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 带标签的连线 -->
<mxCell id="x" value="数据/JSON" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#666666;strokeWidth=1.5;endArrow=classic;fontSize=10;labelBackgroundColor=#FFFFFF;" edge="1" parent="1" source="src_id" target="tgt_id">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 虚线连线 -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#999999;strokeWidth=1;endArrow=classic;dashed=1;dashPattern=8 8;" edge="1" parent="1" source="src_id" target="tgt_id">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
```

## Diagram-Specific Templates

### 1. 技术架构图 - 分层布局

Key approach: Use large containers for each layer, stack them vertically.

```
Canvas: 1200×1000
Layer containers: width=1000, height varies
Layer gaps: 10px between containers
Component nodes inside layers: width=140-180, height=50, gap=20
```

Layer color scheme:
- 用户/接入层: container fill=#E3F2FD, component fill=#BBDEFB
- 业务应用层: container fill=#E8F5E9, component fill=#C8E6C9
- 平台服务层: container fill=#FFF3E0, component fill=#FFE0B2
- 数据层: container fill=#F3E5F5, component fill=#E1BEE7
- 基础设施层: container fill=#ECEFF1, component fill=#CFD8DC

### 2. 业务流程图 - 泳道布局

Key approach: Use swimlane containers side by side (horizontal layout).

```
Canvas: depends on flow complexity
Swimlane width: ~200-250 each (for role-based)
Node spacing: horizontal 40px, vertical 60px
```

### 3. 数据流图 - 从左到右

Key approach: External entities on left/right edges, processes in middle, data stores at bottom.

### 4. 功能架构图 - 树形分层

Key approach: Top-down hierarchical containers with modules.

```
Top level: Platform title bar (width=900, height=40)
Second level: Module containers (width=200-250 each, height=240)
Third level: Feature nodes inside containers (width=160, height=40)
```

### 5. 系统集成图 - 中心辐射

Key approach: Core system in center (big), external systems around (smaller), radial connections.

```
Core: x=500, y=350, width=200, height=120
External: arranged in circle at radius=350
  - Top: x=450, y=50
  - Right: x=800, y=350
  - Bottom: x=450, y=650
  - Left: x=100, y=350
  - Corners at 45° angles
```

## ID Generation

Use sequential IDs starting from "2" (IDs "0" and "1" are reserved for root).

Each shape uses a unique ID string. Edge IDs can share the same "x" placeholder convention — replace with actual sequential numbers.

## Positioning Tips

1. Align to grid: positions should typically be multiples of 10 (grid size)
2. Consistent spacing: maintain equal gaps between sibling nodes (20-40px)
3. Center alignment: nodes in the same layer should align horizontally (same `y`) or vertically (same `x`), unless in a progressive flow
4. Container padding: leave at least 30px margin inside containers for inner nodes
5. Label visibility: ensure edge labels don't overlap nodes — use `labelBackgroundColor=#FFFFFF` for readability

---

## ArchiMate 3.2 视图模板

ArchiMate 3.2 是 The Open Group 发布的企业架构建模标准，提供六层建模体系（Strategy / Business / Application / Technology / Physical / Implementation & Migration）和 14 种标准 Viewpoints。以下模板覆盖最常用的 5 种 ArchiMate Viewpoint。

### ArchiMate 元素样式规范

ArchiMate 各层元素使用统一配色，区分层与元素类型：

| 层 | 容器/主色 | 元素填充 | 边框色 | 字体 |
|----|-----------|---------|--------|------|
| **Strategy 战略层** | #FFF3E0 | #FFE0B2 | #F57C00 | 粗体 13px |
| **Business 业务层** | #FFFDE7 | #FFF9C4 | #FBC02D | 粗体 13px |
| **Application 应用层** | #E3F2FD | #BBDEFB | #1E88E5 | 常规 12px |
| **Technology 技术层** | #E8F5E9 | #C8E6C9 | #43A047 | 常规 12px |
| **Physical 物理层** | #ECEFF1 | #CFD8DC | #607D8B | 常规 12px |
| **Motivation 动机** | #F3E5F5 | #E1BEE7 | #8E24AA | 粗体 12px |

### ArchiMate 关系连线样式

```xml
<!-- 组合关系 Composition（实心菱形） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#333333;strokeWidth=2;endArrow=diamondThin;endFill=1;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 聚合关系 Aggregation（空心菱形） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#333333;strokeWidth=2;endArrow=diamondThin;endFill=0;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 分配关系 Assignment（虚线+实心菱形） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#666666;strokeWidth=1.5;endArrow=diamondThin;endFill=1;dashed=1;dashPattern=5 5;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 实现关系 Realization（虚线+空心三角） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#666666;strokeWidth=1.5;endArrow=openThin;endFill=0;dashed=1;dashPattern=5 5;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 服务关系 Serving（实线+空心三角） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#1E88E5;strokeWidth=1.5;endArrow=openThin;endFill=0;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 触发关系 Triggering（实线+实心箭头） -->
<mxCell id="x" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#F57C00;strokeWidth=1.5;endArrow=classic;fontSize=10;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 流关系 Flow（虚线+实心箭头） -->
<mxCell id="x" value="数据流" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#43A047;strokeWidth=1.5;endArrow=classic;dashed=1;dashPattern=8 8;fontSize=10;labelBackgroundColor=#FFFFFF;" edge="1" parent="1" source="src" target="tgt">
  <mxGeometry relative="1" as="geometry" />
</mxCell>
```

### A.1 Motivation Viewpoint（动机视图）— 利益相关者关注

**用途**：回答"为什么做？值不值得做？"，适用于高管汇报。展示 Stakeholder → Driver → Assessment → Goal → Outcome → Principle 的因果链。

```
Canvas: 1400×900
布局：从左到右因果链
  - 左列：Stakeholder（人形图标）→ Driver（六边形）
  - 中列：Assessment（矩形）→ Goal（圆角矩形）
  - 右列：Outcome（椭圆）→ Principle（带图标矩形）
节点间距：水平 120px，垂直 80px
```

**关键元素模板**：

```xml
<!-- Stakeholder 利益相关者 -->
<mxCell id="x" value="CIO" style="shape=actor;whiteSpace=wrap;html=1;fillColor=#F3E5F5;strokeColor=#8E24AA;fontSize=13;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="80" y="100" width="60" height="100" as="geometry" />
</mxCell>

<!-- Driver 驱动因素（六边形） -->
<mxCell id="x" value="数字化转型压力" style="shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fillColor=#E1BEE7;strokeColor=#8E24AA;fontSize=12;size=20;" vertex="1" parent="1">
  <mxGeometry x="220" y="110" width="140" height="80" as="geometry" />
</mxCell>

<!-- Assessment 评估 -->
<mxCell id="x" value="当前系统维护成本&#xa;年增长35%" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#FFE0B2;strokeColor=#F57C00;fontSize=12;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="440" y="100" width="160" height="70" as="geometry" />
</mxCell>

<!-- Goal 目标 -->
<mxCell id="x" value="降低运维成本30%" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#C8E6C9;strokeColor=#43A047;fontSize=13;fontStyle=1;arcSize=20;" vertex="1" parent="1">
  <mxGeometry x="680" y="100" width="150" height="60" as="geometry" />
</mxCell>

<!-- Outcome 成果 -->
<mxCell id="x" value="云原生平台上线" style="ellipse;whiteSpace=wrap;html=1;fillColor=#BBDEFB;strokeColor=#1E88E5;fontSize=13;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="910" y="100" width="150" height="60" as="geometry" />
</mxCell>

<!-- Principle 原则 -->
<mxCell id="x" value="Cloud-First战略" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#FFE0B2;strokeColor=#F57C00;fontSize=13;fontStyle=1;arcSize=15;dashed=1;" vertex="1" parent="1">
  <mxGeometry x="1140" y="100" width="140" height="60" as="geometry" />
</mxCell>
```

### A.2 Layered Viewpoint（分层视图）— 横向分层展示

**用途**：展示企业架构各层（业务→应用→技术）的结构与依赖关系。这是最常用的 ArchiMate 视图。

```
Canvas: 1400×1000
布局：从上到下三层
  - 顶层 Business Layer：y=40, height=280
  - 中层 Application Layer：y=340, height=280
  - 底层 Technology Layer：y=640, height=280
层间间距：20px
每层内部节点水平排列，gap=30
```

**分层容器模板**：

```xml
<!-- 业务层容器 -->
<mxCell id="biz-layer" value="Business Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFDE7;strokeColor=#FBC02D;fontSize=14;fontStyle=1;verticalAlign=top;spacingTop=5;opacity=30;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="1320" height="280" as="geometry" />
</mxCell>

<!-- 应用层容器 -->
<mxCell id="app-layer" value="Application Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#E3F2FD;strokeColor=#1E88E5;fontSize=14;fontStyle=1;verticalAlign=top;spacingTop=5;opacity=30;" vertex="1" parent="1">
  <mxGeometry x="40" y="340" width="1320" height="280" as="geometry" />
</mxCell>

<!-- 技术层容器 -->
<mxCell id="tech-layer" value="Technology Layer" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#E8F5E9;strokeColor=#43A047;fontSize=14;fontStyle=1;verticalAlign=top;spacingTop=5;opacity=30;" vertex="1" parent="1">
  <mxGeometry x="40" y="640" width="1320" height="280" as="geometry" />
</mxCell>
```

### A.3 Service Realization Viewpoint（服务实现视图）

**用途**：展示业务服务如何由应用服务实现，应用服务又如何由技术基础设施支撑。适用于方案汇报中的"端到端服务实现链路"。

```
Canvas: 1200×900
布局：自上而下四层
  Business Service → Application Service → Application Component → Technology Node
每层 2-3 个节点，层间使用 Realization 虚线+空心三角连接
```

### A.4 Capability Map Viewpoint（能力地图视图）

**用途**：展示组织的能力地图（Capability Map），按战略/客户/运营三个维度组织。适用于业务架构图。

```
Canvas: 1200×800
布局：嵌套矩形
  外层：Capability 域（Strategy / Customer / Operations）
  内层：具体 Capability 子项
配色：Strategy=#FFF3E0, Customer=#E3F2FD, Operations=#E8F5E9
```

**能力地图元素模板**：

```xml
<!-- Capability 域容器 -->
<mxCell id="cap-domain" value="客户管理" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#E3F2FD;strokeColor=#1E88E5;fontSize=14;fontStyle=1;verticalAlign=top;spacingTop=5;opacity=25;" vertex="1" parent="1">
  <mxGeometry x="60" y="60" width="350" height="300" as="geometry" />
</mxCell>

<!-- Capability 子项 -->
<mxCell id="cap-item" value="客户360视图" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#BBDEFB;strokeColor=#1E88E5;fontSize=12;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="90" y="120" width="130" height="50" as="geometry" />
</mxCell>
```

### A.5 Implementation & Migration Viewpoint（实施与迁移视图）

**用途**：展示从当前架构到目标架构的迁移路径，包含 Work Package、Plateau、Gap 元素。适用于实施路线图。

```
Canvas: 1400×800
布局：时间线从左到右
  Baseline Architecture → Transition A → Transition B → Target Architecture
Plateau 用大容器表示，Work Package 用小矩形，Gap 用虚线矩形
配色：Baseline=#ECEFF1, Transition=#FFF3E0, Target=#E8F5E9
```

---

## Wardley Map 战略决策框架模板

Wardley Mapping 是 Simon Wardley 创建的战略决策框架，通过可视化价值链上各组件的位置（Visibility）和演变阶段（Evolution），帮助企业做出自建/采购/外包/标准化决策。

### Wardley Map 画布结构

```
Canvas: 1400×900
坐标系统：
  - 纵轴（Y）：Visibility — 从下到上，从不可见（基础设施）到可见（用户需求）
  - 横轴（X）：Evolution — 从左到右，Genesis → Custom → Product → Commodity
  - 锚点：左上角 (100, 50) = 用户需求
  - 锚点：右下角 (1300, 800) = 商品化基础设施
```

### 演变阶段区域划分

| 阶段 | X 范围 | 背景色 | 含义 |
|------|--------|--------|------|
| **Genesis 创世** | x: 100-350 | #FFCDD2 (浅红) | 全新、不确定、实验性 |
| **Custom 定制** | x: 350-650 | #FFF9C4 (浅黄) | 自建为主、差异化 |
| **Product 产品** | x: 650-950 | #BBDEFB (浅蓝) | 市场产品化、竞争激烈 |
| **Commodity 商品** | x: 950-1300 | #C8E6C9 (浅绿) | 标准化、按需使用 |

### Wardley Map 阶段区域背景

```xml
<!-- Genesis 阶段区域 -->
<mxCell id="zone-genesis" value="Genesis" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#FFCDD2;strokeColor=#E57373;fontSize=12;fontStyle=1;verticalAlign=top;spacingTop=3;opacity=20;" vertex="1" parent="1">
  <mxGeometry x="100" y="50" width="250" height="750" as="geometry" />
</mxCell>

<!-- Custom 阶段区域 -->
<mxCell id="zone-custom" value="Custom Built" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#FFF9C4;strokeColor=#FBC02D;fontSize=12;fontStyle=1;verticalAlign=top;spacingTop=3;opacity=20;" vertex="1" parent="1">
  <mxGeometry x="350" y="50" width="300" height="750" as="geometry" />
</mxCell>

<!-- Product 阶段区域 -->
<mxCell id="zone-product" value="Product (+Rental)" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#BBDEFB;strokeColor=#1E88E5;fontSize=12;fontStyle=1;verticalAlign=top;spacingTop=3;opacity=20;" vertex="1" parent="1">
  <mxGeometry x="650" y="50" width="300" height="750" as="geometry" />
</mxCell>

<!-- Commodity 阶段区域 -->
<mxCell id="zone-commodity" value="Commodity (+Utility)" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#C8E6C9;strokeColor=#43A047;fontSize=12;fontStyle=1;verticalAlign=top;spacingTop=3;opacity=20;" vertex="1" parent="1">
  <mxGeometry x="950" y="50" width="350" height="750" as="geometry" />
</mxCell>
```

### 组件节点（Component Node）模板

Wardley Map 中每个组件用圆角矩形表示，大小反映其"重要性"或"规模"：

```xml
<!-- 用户需求锚点（最顶层） -->
<mxCell id="user-need" value="用户需求：实时数据洞察" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#FF7043;strokeColor=#D84315;fontSize=14;fontStyle=1;fontColor=#FFFFFF;arcSize=15;" vertex="1" parent="1">
  <mxGeometry x="500" y="60" width="220" height="55" as="geometry" />
</mxCell>

<!-- Genesis 阶段组件（实验性，小尺寸） -->
<mxCell id="comp-ml" value="ML预测引擎" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#EF9A9A;strokeColor=#E57373;fontSize=12;fontStyle=1;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="140" y="350" width="130" height="45" as="geometry" />
</mxCell>

<!-- Custom 阶段组件（自建，中尺寸） -->
<mxCell id="comp-api" value="数据集成API" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#FFF176;strokeColor=#FBC02D;fontSize=12;fontStyle=1;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="400" y="280" width="140" height="45" as="geometry" />
</mxCell>

<!-- Product 阶段组件（产品化，中尺寸） -->
<mxCell id="comp-db" value="时序数据库" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#64B5F6;strokeColor=#1E88E5;fontSize=12;fontStyle=1;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="720" y="280" width="130" height="45" as="geometry" />
</mxCell>

<!-- Commodity 阶段组件（商品化，大尺寸） -->
<mxCell id="comp-compute" value="云计算 (IaaS)" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#81C784;strokeColor=#43A047;fontSize=12;fontStyle=1;arcSize=10;" vertex="1" parent="1">
  <mxGeometry x="1050" y="450" width="150" height="45" as="geometry" />
</mxCell>
```

### 价值链连线（Value Chain Link）

Wardley Map 中组件之间的连线表示依赖关系，通常使用带标签的直线：

```xml
<!-- 价值链依赖连线 -->
<mxCell id="edge-vc" value="需要" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#666666;strokeWidth=2;endArrow=classic;fontSize=10;labelBackgroundColor=#FFFFFF;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="user-need" target="comp-api">
  <mxGeometry relative="1" as="geometry" />
</mxCell>

<!-- 演变箭头（Evolution Arrow）— 从左到右的粗箭头 -->
<mxCell id="evolution-arrow" value="" style="endArrow=classic;html=1;strokeColor=#999999;strokeWidth=3;fontSize=10;" edge="1" parent="1">
  <mxGeometry width="50" height="50" relative="1" as="geometry">
    <mxPoint x="100" y="820" as="sourcePoint" />
    <mxPoint x="1300" y="820" as="targetPoint" />
  </mxGeometry>
</mxCell>

<!-- 演变标签 -->
<mxCell id="evolution-label" value="Evolution → (Genesis → Custom → Product → Commodity)" style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=11;fontColor=#666666;fontStyle=2;" vertex="1" parent="1">
  <mxGeometry x="450" y="830" width="500" height="25" as="geometry" />
</mxCell>
```

### Wardley Map 布局原则

1. **锚定用户需求**：最顶部的组件必须是用户需求，放在 Product 阶段区域（x≈500-700）
2. **价值链向下延伸**：每个组件下方是其依赖的组件，形成可见的依赖链
3. **横轴反映演变**：越成熟的组件越靠右（Commodity），越新颖的越靠左（Genesis）
4. **组件大小反映重要性**：关键组件用较大尺寸（width≥150），辅助组件用小尺寸（width≤120）
5. **标注战略决策**：在组件旁添加注释气泡，标注"自建/采购/外包/标准化"决策

### Wardley Map 注释气泡（Annotation）

```xml
<!-- 战略决策注释 -->
<mxCell id="annotation" value="建议：采购成熟产品&#xa;而非自建" style="shape=callout;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#F57C00;fontSize=10;perimeter=calloutPerimeter;size=15;position2=0.5;" vertex="1" parent="1">
  <mxGeometry x="750" y="200" width="130" height="55" as="geometry" />
</mxCell>
```
