// BepInEx 插件元数据读取器（只读反射，不执行任何插件代码）
//
// 用法：
//   plugin-metadata-reader --core <BepInEx/core> --plugins <BepInEx/plugins>
//   插件 dll 绝对路径从 stdin 逐行传入（每行一个）
//
// 输出：stdout 每行一个 JSON 对象：
//   {"path":"C:\\...\\MyMod.dll","guid":"com.example.mymod","name":"My Mod","version":"1.0.0","dependencies":["com.example.lib"]}
//   解析失败时输出 {"path":"...","error":"错误信息"}
//
// 使用 MetadataLoadContext 只读加载程序集：只解析元数据，绝不执行目标代码。

using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using System.Text.Json;

Console.OutputEncoding = Encoding.UTF8;

// ---- 解析命令行参数 ----
string? coreDir = null;
string? pluginsDir = null;
var extraDirs = new List<string>();
bool debug = false;
for (int i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--core" when i + 1 < args.Length: coreDir = args[++i]; break;
        case "--plugins" when i + 1 < args.Length: pluginsDir = args[++i]; break;
        case "--dir" when i + 1 < args.Length: extraDirs.Add(args[++i]); break;
        case "--debug": debug = true; break;
        default: break;
    }
}

// ---- 读取 dll 路径（stdin，每行一个）----
var dllPaths = new List<string>();
string? line;
while ((line = Console.ReadLine()) != null)
{
    line = line.Trim();
    if (line.Length > 0) dllPaths.Add(line);
}

if (dllPaths.Count == 0) return 0;

// ---- 组装解析器搜索路径 ----
// 插件程序集的依赖（Unity、BepInEx、同目录 dll）必须能被解析到，
// 否则 GetCustomAttributesData 遇到解析不了的依赖类型会失败。
var searchPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    Path.GetDirectoryName(typeof(object).Assembly.Location) ?? "" // 核心库（System.* 等）
};
if (coreDir != null && Directory.Exists(coreDir)) searchPaths.Add(coreDir);
if (pluginsDir != null && Directory.Exists(pluginsDir)) searchPaths.Add(pluginsDir);
foreach (var d in extraDirs)
{
    if (Directory.Exists(d)) searchPaths.Add(d);
}
// 每个 dll 所在目录也加入（插件可能依赖同目录的其他 dll）
foreach (var dll in dllPaths)
{
    var dir = Path.GetDirectoryName(dll);
    if (dir != null) searchPaths.Add(dir);
}

var allAssemblies = new List<string>();
foreach (var dir in searchPaths)
{
    try { allAssemblies.AddRange(Directory.GetFiles(dir, "*.dll")); } catch { /* 忽略不可读目录 */ }
}
allAssemblies.AddRange(dllPaths);

var resolver = new PathAssemblyResolver(allAssemblies.Distinct(StringComparer.OrdinalIgnoreCase));

using var mlc = new MetadataLoadContext(resolver);

// ---- 逐个解析（并行，提升大插件包速度）----
var results = new ConcurrentBag<string>();
Parallel.ForEach(dllPaths, dll => { results.Add(ParseOne(mlc, dll, debug)); });

foreach (var r in results) Console.WriteLine(r);
return 0;

// ---- 解析单个程序集 ----
static string ParseOne(MetadataLoadContext mlc, string dllPath, bool debug)
{
    try
    {
        var asm = mlc.LoadFromAssemblyPath(dllPath);
        string? guid = null, name = null, version = null;
        var dependencies = new List<string>();

        IList<CustomAttributeData> attrs;
        try
        {
            attrs = asm.GetCustomAttributesData();
        }
        catch (Exception ex)
        {
            return Json(new { path = dllPath, error = $"GetCustomAttributesData 失败: {ex.Message}" });
        }

        if (debug)
        {
            var names = string.Join(",", attrs.Select(a => a.AttributeType.FullName ?? a.AttributeType.Name));
            Console.Error.WriteLine($"[debug] {Path.GetFileName(dllPath)} asm-attrs: {names}");
        }

        // BepInPlugin / BepInDependency 特性可能出现在：程序集级（老式写法）或插件类级（BepInEx 5/6 标准写法）
        // 因此先扫程序集级，再扫所有类型的类级特性
        var assemblyAttrs = new List<CustomAttributeData>(attrs);
        var typeAttrs = new List<CustomAttributeData>();
        try
        {
            foreach (var t in asm.GetTypes())
            {
                try { typeAttrs.AddRange(t.GetCustomAttributesData()); }
                catch { /* 单个类型解析失败不影响其他 */ }
            }
        }
        catch { /* GetTypes 失败则只依赖程序集级 */ }

        if (debug)
        {
            var names = string.Join(",", typeAttrs.Select(a => a.AttributeType.FullName ?? a.AttributeType.Name));
            Console.Error.WriteLine($"[debug] {Path.GetFileName(dllPath)} type-attrs: {names}");
        }

        foreach (var attr in assemblyAttrs.Concat(typeAttrs))
        {
            switch (attr.AttributeType.Name)
            {
                case "BepInPlugin":
                    // BepInPlugin(string GUID, string Name, string Version)
                    if (attr.ConstructorArguments.Count >= 3)
                    {
                        guid = ReadString(attr.ConstructorArguments[0]);
                        name = ReadString(attr.ConstructorArguments[1]);
                        version = ReadString(attr.ConstructorArguments[2]);
                    }
                    break;
                case "BepInDependency":
                    // BepInDependency(string dependencyGUID) / (string, DependencyFlags)
                    if (attr.ConstructorArguments.Count >= 1)
                    {
                        var dep = ReadString(attr.ConstructorArguments[0]);
                        if (dep != null) dependencies.Add(dep);
                    }
                    break;
            }
        }

        if (guid == null)
        {
            return Json(new { path = dllPath, error = "未找到 BepInPlugin 特性（可能不是 BepInEx 插件）" });
        }

        return Json(new
        {
            path = dllPath,
            guid,
            name = name ?? dllPath,
            version = version ?? "0.0.0",
            dependencies = dependencies.ToArray()
        });
    }
    catch (Exception ex)
    {
        return Json(new { path = dllPath, error = ex.Message });
    }
}

static string? ReadString(CustomAttributeTypedArgument arg)
{
    try
    {
        return arg.Value as string;
    }
    catch
    {
        return null;
    }
}

static string Json(object obj) => JsonSerializer.Serialize(obj);
