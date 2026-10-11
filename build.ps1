# Собирает Windows-приложение: dist\Покер.exe (один файл, установка не нужна).
# Нужен .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out = Join-Path $root 'dist'
$publish = Join-Path $root 'app\bin\publish'

dotnet publish (Join-Path $root 'app\PokerApp.csproj') -c Release -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась (код $LASTEXITCODE)" }

New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $publish 'Poker.exe') (Join-Path $out 'Покер.exe') -Force
Write-Host "Готово: $(Join-Path $out 'Покер.exe')"
