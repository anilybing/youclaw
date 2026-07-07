# office-pdf 示例说明

本技能不附带静态示例 PDF：测试样例是**动态生成**的——`skills-dev/tests/office-pdf.test.ts` 在运行时用 pdf-lib 于系统临时目录生成样例 PDF（3 页 + 2 页），跑完 merge / split / watermark 三种模式的断言后自动清理，不向仓库写入任何二进制样例文件。

命令行调用示例见上级目录 `SKILL.md` 中各 mode 的说明。
