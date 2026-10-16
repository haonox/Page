---
id: go-worker-pool
date: 2026-10-09
category: other
title: Go 并发 Worker Pool 经典代码
---

# Go 并发 Worker Pool 经典代码

> 本文针对下述"生产者 + 多 Worker + 结果收集"的经典 worker pool 代码，给出**从协程创建到程序退出的完整执行时序**。

---

## 一、代码全貌

```go
package main

import (
        "fmt"
        "sync"
)

func worker(
        id int,
        jobs <-chan int,    // 只读通道：worker 只能从 jobs 取任务
        results chan<- int, // 只写通道：worker 只能向 results 写结果
        wg *sync.WaitGroup, // 必须传指针
) {
        defer wg.Done() // 函数退出时，wg 计数 -1
        for job := range jobs {
                fmt.Printf("worker %d processing %d\n", id, job)
                results <- job * job // 把平方结果写入 results
        }
}

func main() {
        jobs := make(chan int)
        results := make(chan int)
        var wg sync.WaitGroup

        // 1. 启动 3 个 worker 协程
        for i := 1; i <= 3; i++ {
                wg.Add(1)
                go worker(i, jobs, results, &wg)
        }

        // 2. 生产者协程：投放 10 个任务
        go func() {
                for i := 1; i <= 10; i++ {
                        jobs <- i
                }
                close(jobs) // 任务投完，关闭 jobs 通道
        }()

        // 3. 等待关闭协程：等所有 worker 完成，再关闭 results
        go func() {
                wg.Wait()
                close(results)
        }()

        // 4. 主协程：range 读取结果
        for result := range results {
                fmt.Println("result:", result)
        }
}
```

---

## 二、协程全景图

一次执行中，程序共有 **1 个主协程 + 5 个子协程**：


| 编号 | 协程 | 启动处 | 核心职责 | 初始阻塞点 |
| ---- | ---- | ---- | ---- | ---- |
| 主协程 | main goroutine | `func main()` | 创建 5 个子协程，range 读取结果 | `for result := range results` |
| 子协程 1 | worker 1 | `go worker(1,...)` | 取任务、算平方、写结果 | `for job := range jobs` |
| 子协程 2 | worker 2 | `go worker(2,...)` | 同上 | `for job := range jobs` |
| 子协程 3 | worker 3 | `go worker(3,...)` | 同上 | `for job := range jobs` |
| 子协程 4 | 生产者 | `go func(){ jobs<-i ... }` | 依次向 jobs 发送 1~10，最后 close(jobs) | 无（就绪） |
| 子协程 5 | 等待关闭 | `go func(){ wg.Wait(); close(results) }` | 等待 3 个 worker 全部结束，close(results) | `wg.Wait()` |

> **重要**：5 个子协程是主协程**按代码顺序逐个**通过 go 创建，创建动作有纳秒级先后差异，并非绝对同一瞬间生成；但放入调度队列后由 GMP 调度器并发调度，**业务层面不可依赖它们的启动顺序**。

---

## 三、完整执行流程

### 阶段 0：初始状态（5 个子协程全部入队之后）

主协程已执行完 5 次 go，走到 for result := range results。

此刻各协程状态：

- 3 个 worker：全部卡在 for job := range jobs（jobs 为空、未关闭，range 读取空通道 → 阻塞）

- 生产者：就绪，准备执行 for i:=1; i<=10; jobs<-i

- 等待关闭协程：卡在 wg.Wait()（wg 计数 = 3）

- 主协程：卡在 for result := range results（results 为空、未关闭 → 阻塞）

### 阶段 1：任务投递与处理（调度器来回切换）

**生产者**被调度运行，执行 jobs <- 1：

- jobs 是**无缓冲通道**，发送必须等到有接收方，否则发送阻塞。

- 调度器切到某个空闲 worker，worker 跳出 range jobs 阻塞，拿到 job=1：

- 打印 worker X processing 1

- 执行 results <- 1*1

- results <- 同样无缓冲，要等主协程接收才放行：

- 主协程从 results 读到 1，打印 result: 1，继续阻塞等下一条。

生产者继续循环 jobs <- 2,3,...,10，每次发送都阻塞、唤醒空闲 worker 抢任务。

> 3 个 worker **并发抢任务**，谁空闲谁拿，任务分配顺序不确定。 worker 处理完一个任务、写完结果后，立即回到 for range jobs 抢下一个。

### 阶段 2：任务投完，关闭 jobs

生产者发送完 10，执行 close(jobs)：

- worker 的 for job := range jobs 在**读完剩余任务后自动退出**（通道关闭 + 数据读完 → range 结束）。

- worker 函数退出 → 触发开头的 defer wg.Done()，wg 计数减 1。

### 阶段 3：所有 worker 完成，关闭 results

- 3 个 worker 各自完成全部任务后都执行了 wg.Done()。

- 当第 3 个 worker Done，wg 计数归零 → 子协程 5 的 wg.Wait() 解除阻塞，执行 close(results)。

### 阶段 4：主协程读完结果，程序退出

- 主协程继续 for result := range results，读完通道内剩余结果。

- results 关闭且数据读完 → range 自动结束 → main() 返回 → **主协程退出，整个程序终止**。

## 四、运行输出示例

> worker 处理顺序每次可能不同（并发抢任务），但结果集合固定为 1,4,9,...,100。

```
worker 1 processing 1
worker 2 processing 2
worker 3 processing 3
result: 1
result: 4
result: 9
worker 1 processing 4
worker 2 processing 5
worker 3 processing 6
result: 16
result: 25
result: 36
worker 1 processing 7
worker 2 processing 8
worker 3 processing 9
result: 49
result: 64
result: 81
worker 1 processing 10
result: 100
```

***

## 五、关键机制拆解

### 1. 单向通道（方向限制）

- `jobs <-chan int`：worker 对 jobs **只读**，不能 send（编译期检查）。
- `results chan<- int`：worker 对 results **只写**，不能 read。

### 2. `wg` 为什么必须传指针 `*sync.WaitGroup`？

`sync.WaitGroup` 是结构体，**传值会拷贝一份独立状态**，内部计数器互不相通，`wg.Wait()` 将永远等不到 Done → 死锁。必须传地址。

### 3. 为什么 `wg.Wait()` 要放到单独的子协程？

若直接在 main 主协程写 `wg.Wait()`，主协程卡在 Wait，**永远执行不到下面 `for range results` 读取结果**，程序死锁。

> 把"等待 + close(results)"拆到子协程，让主协程专心读结果。

### 4. `for range channel` 的退出规则

- 通道**打开、有数据**：读出一条，进入循环体。
- 通道**打开、无数据**：阻塞等待。
- 通道**关闭、数据读完**：循环自动结束（不会阻塞、不会 panic）。

主协程 range results 依赖 `close(results)` 才能退出，否则永久阻塞死锁。

### 5. worker 在 `results <- job*job` 会阻塞

无缓冲通道下，若主协程读取结果慢，worker 会卡在这一行，**无法回到 jobs 抢下一个任务**，形成背压（backpressure）。

***