---
id: go-value-reference
date: 2026-10-16
title: Go 中的值类型和引用类型
---


# Go 中的值类型和引用类型

> 日常学习笔记，理解赋值和传参之后，修改是否会影响原来的变量或数据。

## 1. 先记住 Go 的值拷贝规则

**Go 的赋值和函数传参都按值复制。** `b := a` 将 `a` 的值复制给 `b`。调用 `f(a)` 时，形参得到的也是 `a` 的值。理解一个类型的关键是看它的值里存了什么，以及复制后能否访问同一份数据。[Go 官方 FAQ · 函数如何传参](https://go.dev/doc/faq#pass_by_value)

| 常见类型 | 赋值或传参时复制什么 | 复制后可能共享什么 |
| --- | --- | --- |
| `int`、`float64`、`bool` | 数字或布尔值 | — |
| `string` | 字符串值 | 实现可以共享字节，字符串内容不可变 |
| 数组 `[N]T`、结构体 `struct` | 每个元素或字段的值 | 元素或字段里的引用可能仍指向同一份数据 |
| 指针 `*T` | 指针值 | 同一个变量 |
| 切片 `[]T` | 切片描述符，含起点、长度、容量 | 同一个底层数组 |
| 映射 `map[K]V` | map 值 | 同一张映射表 |
| 通道 `chan T` | 通道值 | 同一条通道 |
| 函数 `func(...)` | 函数值 | 闭包捕获的变量 |
| 接口 `interface`、`any` | 接口的动态类型和动态值 | 取决于动态值包含的引用 |

通常把可独立使用的值称为「值类型」，把值中带有底层数据引用的类型简称为「引用类型」。这两个叫法描述的是值的内容和共享行为。上表中的类型都遵循同一套赋值和传参规则。[Go 语言规范 · 值的表示](https://go.dev/ref/spec#Representation_of_values)

## 2. 数组和结构体会复制元素或字段

复制数组后，给副本里的 `int` 元素赋值，只会改副本。结构体也是逐字段复制。如果某个字段是切片，复制这个字段得到的是一份新的切片描述符，仍可访问同一个底层数组。

```go
a := [2]int{1, 2}
b := a
b[0] = 99
fmt.Println(a, b) // [1 2] [99 2]

type Result struct {
    Score int
    Items []int
}

first := Result{Score: 10, Items: []int{1, 2}}
second := first
second.Score = 20
second.Items[0] = 99
fmt.Println(first.Score, first.Items) // 10 [99 2]
```

如果要让 `Items` 也独立，可以给副本分配一个新的切片，再用 `copy` 复制元素。对于多层嵌套的数据，需要沿着想要独立的层级逐层复制。

## 3. 指针传参会复制地址

形参本身是函数里的局部变量。给形参赋一个新值，只会更新这个局部变量。若形参是指针，可以用 `*p` 修改它指向的变量。

```go
setValue := func(n int) {
    n = 20
}
setThroughPointer := func(p *int) {
    *p = 30
}

x := 10
setValue(x)
fmt.Println(x) // 10

setThroughPointer(&x)
fmt.Println(x) // 30
```

`p = &other` 和 `*p = 30` 是两个不同的操作。前者改变局部指针 `p` 的指向，后者修改 `p` 所指的变量。

## 4. 切片传参会复制描述符

函数收到的切片参数与调用方各自记录长度和容量。两者共享底层数组时，写 `s[i]` 会改到共享元素。对形参截取或追加后，给形参赋回结果，只会更新函数里的切片描述符。

```go
update := func(s []int) []int {
    s[0] = 99
    return append(s, 2)
}

nums := make([]int, 1, 2)
nums[0] = 1
updated := update(nums)

fmt.Println(nums, len(nums)) // [99] 1
fmt.Println(updated)        // [99 2]
fmt.Println(nums[:2])       // [99 2]
```

这里剩余容量足够，追加的 `2` 写进了共享的底层数组。`nums` 自己的长度仍是 `1`，重新截取到长度 `2` 后才能读取那个位置。如果容量不足，`append` 会分配新数组，复制已有元素，再写入追加项。调用方要使用追加后的切片，可以写 `nums = update(nums)`。[Go 语言规范 · append 与 copy](https://go.dev/ref/spec#Appending_and_copying_slices)

## 5. map、通道和闭包也能共享数据

给 `map` 的键赋值或调用 `delete` 会修改映射表。把一个全新的 map 值赋给局部形参，只会改变该形参指向哪张表。

```go
update := func(m map[string]int) {
    m["go"]++
    m = map[string]int{"go": 100}
    fmt.Println(m["go"]) // 100，读的是新表
}

counts := map[string]int{"go": 1}
update(counts)
fmt.Println(counts["go"]) // 2，读的是原表
```

- **通道**：`other := ch` 复制通道值，两个变量可以在同一条通道上收发。
- **闭包**：如果函数捕获了外部变量，复制这个函数值后，通过两个副本调用函数时，访问的仍是同一个被捕获的变量。[Go 语言规范 · 值的表示与闭包](https://go.dev/ref/spec#Representation_of_values)

## 6. 接口取决于里面装了什么

接口值包含动态类型和动态值。以 `var v any = [1]int{1}` 为例，`v` 的静态类型是 `any`，动态类型是 `[1]int`，动态值是数组 `[1]int{1}`。接口里装数组时，保存的是数组的值。装切片或指针时，保存的值里仍带着对底层数据的引用。[Go 官方 FAQ · 接口的复制](https://go.dev/doc/faq#pass_by_value)

```go
arr := [1]int{1}
var arrValue any = arr
arr[0] = 99
fmt.Println(arrValue) // [1]

nums := []int{1}
var sliceValue any = nums
nums[0] = 99
fmt.Println(sliceValue) // [99]
```

## 7. 写代码时怎么判断修改会不会传出去

1. **先看复制的是哪个值。** 遇到 `b := a` 或 `f(a)`，先辨认数组 `[N]T`、切片 `[]T` 和指针 `*T`。
2. **再看操作写到了哪里。** `s[i] = x`、`m[k] = v` 和 `*p = x` 会写入底层数据。`s = ...`、`m = ...` 和 `p = ...` 更新的是当前变量。
3. **看到 `append` 就检查容量和返回值。** 容量决定是否复用数组，返回值包含新的长度和容量。需要让调用方使用追加结果时，把新切片返回给它。
