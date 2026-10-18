---
id: ubuntu-docker-proxy
date: 2026-08-20
category: other
title: Ubuntu 安装 Docker Engine 与本地代理配置
---

# Ubuntu 安装 Docker Engine 与本地代理配置

> 记录时间：2026 年 10 月。本文以 Ubuntu 26.04、Docker Engine（非 Docker Desktop）为例。
>
> 前置说明（两种网络方案，二选一）
>
> Docker 获取镜像有两套互斥方案，根据自身网络环境选择：
>
> 1. **有可用境外代理（本文实操方案）**：给 Docker 守护进程配置代理，直接访问官方 Docker Hub。优点：镜像完整、所有官方 / 第三方镜像均可拉取；缺点：必须保证代理服务正常运行，代理关闭后拉取新镜像会超时。本文后续全部基于该方案演示，本机代理提供 HTTP 代理地址 `127.0.0.1:7897`，操作前请替换为你自己的代理端口。
> 2. **无法使用境外代理（备选方案）**：不配置代理，使用国内镜像加速器。通过国内服务商缓存的镜像仓库拉取镜像，速度快。缺点：小众镜像、新发布镜像可能存在缓存缺失，部分镜像版本拉取不到。
>
> 国内镜像加速器参考配置（写入 `/etc/docker/daemon.json`，**不要和 proxies 代理配置同时写在同一个配置文件中**）：
>
> ```
> {
>   "registry-mirrors": [
>     "https://docker.mirrors.ustc.edu.cn",
>     "https://hub-mirror.c.163.com"
>   ]
> }
> ```
>
> 修改配置后执行 `sudo systemctl restart docker` 生效。

本次实操环境：终端开启代理后能访问 Docker 官网和 Docker Hub，但最初 `docker pull` 仍然超时。原因是拉取镜像的网络请求由后台的 `dockerd` 发起，它不会自动继承普通终端中的代理环境变量。最后通过 `/etc/docker/daemon.json` 给守护进程配置代理，成功拉取并运行了 `hello-world`。

## 1. 先确认环境

打开终端，查看系统版本、架构和已有 Docker 安装：

```bash
cat /etc/os-release
dpkg --print-architecture
command -v docker || true
dpkg -l 'docker*' 'containerd*' 2>/dev/null | grep '^ii' || true
```

本文的安装路径是 Docker 官方的 Ubuntu APT 仓库。其他发行版和 Docker Desktop 应使用各自的安装说明。

### 可选：彻底卸载旧安装

**已有可用 Docker 时，直接跳到第 2 节。**下面只适用于确实要从零重装的场景。清除 `/var/lib/docker` 和 `/var/lib/containerd` 会删除本机的镜像、容器、卷等数据；先备份需要保留的内容。

卸载官方 Docker Engine 软件包：

```bash
sudo apt purge docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
```

如果系统还安装过 Ubuntu 自带或其他冲突软件包，也需卸载，例如 `docker.io`、`docker-compose`、`docker-compose-v2`、`docker-doc`、`docker-buildx`、`podman-docker`、`containerd` 和 `runc`。可先用上面的 `dpkg -l` 命令确认，再对实际安装的包执行 `sudo apt remove <包名>`。

只有确认要删除全部 Docker 本地数据时，才执行：

```bash
sudo rm -rf /var/lib/docker /var/lib/containerd
```

如果还想移除旧的官方软件源和密钥，可检查并删除 `/etc/apt/sources.list.d/docker.sources` 与 `/etc/apt/keyrings/docker.asc`。自定义的 `/etc/docker/daemon.json` 不会因卸载软件包而自动消失；重装前先查看它，避免沿用过期配置。以上卸载步骤对应 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/#uninstall-docker-engine)。

## 2. 开启本机代理，分别检查两个网址

本文使用的代理地址为 `http://127.0.0.1:7897`。先确认代理软件正在运行，再执行：

```bash
curl --connect-timeout 5 --max-time 20 -fsSL -o /dev/null \
  -w 'Docker APT: %{http_code}\n' \
  https://download.docker.com/linux/ubuntu/gpg

curl --connect-timeout 5 --max-time 20 -sS -o /dev/null \
  -w 'Docker Hub: %{http_code}\n' \
  https://registry-1.docker.io/v2/
```

本机开启代理时，结果分别是 `Docker APT: 200` 和 `Docker Hub: 401`。后者是未认证访问镜像仓库 API 的正常响应，说明服务已经连通。关闭代理后，本机分别遇到连接重置和超时，这说明在当前网络环境下，安装和拉取镜像需要代理。

还要验证 `sudo` 能访问下载地址，以及代理端口本身能够转发 Docker Hub 请求：

```bash
sudo curl --connect-timeout 5 --max-time 20 -fsSL -o /dev/null \
  -w 'sudo Docker APT: %{http_code}\n' \
  https://download.docker.com/linux/ubuntu/gpg

sudo curl --connect-timeout 5 --max-time 20 \
  --proxy http://127.0.0.1:7897 \
  -sS -o /dev/null -w 'Docker Hub via proxy: %{http_code}\n' \
  https://registry-1.docker.io/v2/
```

本次实测分别得到 `200` 和 `401`。如果第一条失败、第二条成功，后续下载密钥时可以给 `sudo curl` 显式加上 `--proxy http://127.0.0.1:7897`；不要假设 `sudo` 一定继承用户终端的代理变量。

## 3. 从 Docker 官方 APT 仓库安装

按照 [Docker 官方 Ubuntu 安装步骤](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)添加密钥和软件源：

```bash
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl --proxy http://127.0.0.1:7897 -fsSL \
  https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

上面的 `EOF` 必须保持原样，不能写成 `<<'EOF'`，因为这里需要让 shell 展开 Ubuntu 代号和 CPU 架构。如果 `apt update` 访问 Docker 仓库时仍然连不上，可对单次 APT 操作显式指定代理，然后再执行安装命令：

```bash
sudo apt \
  -o Acquire::http::Proxy=http://127.0.0.1:7897 \
  -o Acquire::https::Proxy=http://127.0.0.1:7897 \
  update

sudo apt \
  -o Acquire::http::Proxy=http://127.0.0.1:7897 \
  -o Acquire::https::Proxy=http://127.0.0.1:7897 \
  install docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

检查服务和版本：

```bash
sudo systemctl status docker --no-pager
docker --version
docker compose version
```

## 4. 给 Docker 守护进程配置代理

先看配置文件是否存在：

```bash
sudo ls -l /etc/docker/daemon.json
sudo cat /etc/docker/daemon.json
```

如果提示文件不存在，可以直接创建。**如果已经存在，请用 `sudoedit /etc/docker/daemon.json` 将 `proxies` 对象合并到原有 JSON，别直接覆盖其他设置。**本机配置时该文件不存在，因此执行了：

```bash
sudo install -d -m 0755 /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "proxies": {
    "http-proxy": "http://127.0.0.1:7897",
    "https-proxy": "http://127.0.0.1:7897",
    "no-proxy": "localhost,127.0.0.1,::1"
  }
}
EOF

sudo systemctl restart docker
sudo docker info | grep -i proxy
```

本次输出包含：

```text
HTTP Proxy: http://127.0.0.1:7897
HTTPS Proxy: http://127.0.0.1:7897
No Proxy: localhost,127.0.0.1,::1
```

`https-proxy` 的值以 `http://` 开头是正常的：本地 `7897` 端口提供 HTTP 代理，再通过代理转发 HTTPS 请求。Docker 官方推荐在 `daemon.json` 中配置守护进程代理；修改后需重启 Docker 服务，参见 [Daemon proxy configuration](https://docs.docker.com/engine/daemon/proxy/)。

## 5. 验证拉取和运行

保持代理开启，执行：

```bash
sudo docker pull hello-world
sudo docker run --pull=never --rm hello-world
```

本次 `pull` 成功下载镜像，运行后看到 `Hello from Docker!`。`--pull=never` 明确要求只使用本地镜像，因此第二条命令验证的是本地运行能力。`hello-world` 的固定输出中即使写着“daemon pulled the image”，也不代表这一次 `run` 又联网拉取了镜像。

接着可以关闭代理，再运行同一条命令：

```bash
sudo docker run --pull=never --rm hello-world
```

只要镜像已经在本地，运行不需要访问 Docker Hub。关闭代理后，再次 `docker pull` 仍可能失败：守护进程会尝试连接 `127.0.0.1:7897`，而代理软件此时没有提供服务。需要拉取或更新镜像时重新开启代理即可。`daemon.json` 中的设置属于 **Docker 守护进程访问镜像仓库**的代理；容器内程序访问互联网是否走代理，是另一项配置。

## 6. 常见问题速查

| 现象 | 检查方向 |
| --- | --- |
| 终端 `curl` 成功，但 `docker pull` 超时 | 检查 `sudo docker info` 的 HTTP/HTTPS Proxy；CLI 的环境变量不等于 `dockerd` 的代理设置。 |
| `Docker Hub: 401` | 正常，说明已经连到 Docker Hub 的 API；不是安装失败。 |
| `Docker Hub: 000`、连接重置或超时 | 确认代理软件已开启、端口正确，并用 `curl --proxy` 显式测试。 |
| `sudo curl` 与普通 `curl` 结果不同 | 给 `sudo curl` 显式添加 `--proxy`；不要依赖环境变量继承。 |
| 修改 `daemon.json` 后服务无法启动 | 检查 JSON 语法，再看 `sudo journalctl -u docker -n 80 --no-pager`。 |
| 关闭代理后已有镜像能运行、拉取新镜像失败 | 这是预期行为；联网拉取时重新开启本机代理。 |

本次使用 `sudo docker`，无需额外修改用户组。如果以后希望普通用户直接执行 `docker`，先阅读 [Docker 官方安装后步骤](https://docs.docker.com/engine/install/linux-postinstall/)；加入 `docker` 组会赋予该用户相当于 root 的权限。

## 参考资料

- [Docker 官方：在 Ubuntu 上安装 Docker Engine](https://docs.docker.com/engine/install/ubuntu/)
- [Docker 官方：配置 Docker daemon 代理](https://docs.docker.com/engine/daemon/proxy/)
- [Docker 官方：Linux 安装后步骤](https://docs.docker.com/engine/install/linux-postinstall/)
