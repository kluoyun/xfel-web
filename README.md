# xfel-web

在浏览器里使用 [xfel](https://github.com/xboot/xfel)。原版 xfel 的 C 代码不做任何改动，编译成 WebAssembly，通过 WebUSB 直接操作进入 FEL 模式的全志 SoC。不用装驱动，也不用开命令行。

WebUSB 只有 Chrome 和 Edge 支持，页面需要通过 localhost 或者 HTTPS 访问。

## 构建

需要 emsdk（emcc 在 PATH 里）和 Node.js 20 以上。

```sh
git clone --recurse-submodules https://github.com/kluoyun/xfel-web
cd xfel-web

make            # 编译 wasm，输出 build/xfel.js
npm install
npm run dev     # 开发调试，http://localhost:5173
npm run build   # 打包到 dist/
```

xfel 源码以 git 子模块放在 xfel/ 目录，克隆时记得带 `--recurse-submodules`，忘了的话补一句 `git submodule update --init`。

注意 `make` 要在 `npm run dev` 或 `npm run build` 之前跑，前端加载的是它生成的 build/xfel.js。改了 C 代码要重新 make，只改前端不用。

## 使用

页面点「连接设备」，浏览器弹窗里选中设备，芯片信息、SID 和 SPI Flash 检测会自动完成。

内存和 SPI Flash 的读写用卡片上的按钮。命令行操作在下面的终端里输，用法和 xfel 命令行一样，`version` 和 `xfel version` 都可以，支持 TAB 补全和上下键翻历史：

```
xfel> xfel version
xfel> xfel hexdump 0x0 0x40
```

读写内存之前要先初始化 DDR/PSRAM 控制器（内存卡片里的「初始化DDR」按钮）。部分芯片在控制器没初始化时访问内存会把总线挂死，只能断电重来。

## 测试

```sh
make test        # 命令行路径
make test-glue   # 直接 C API 路径
```

用的是模拟的 FEL 设备，不接真机也能跑。

## 目录结构

```
adapter/   C 适配层：libusb 到 WebUSB 的垫片、直接调用的 C API
src/       React 前端，TypeScript 胶水层在 src/lib/xfel
xfel/      原版 xfel，git 子模块
tests/     node 端到端测试
```

## 致谢

核心功能全部来自 [xboot](https://github.com/xboot) 的 [xfel](https://github.com/xboot/xfel) 项目，本项目只是把它搬进了浏览器。xfel 以子模块形式引入，适配层没有改动它的任何代码，谢谢 xboot。

## 许可证

本项目使用 GPL-3.0（见 LICENSE），xfel 子模块保留其原有的 MIT 许可证。
