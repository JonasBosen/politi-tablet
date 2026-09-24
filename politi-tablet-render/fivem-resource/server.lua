local QBCore, ESX, Framework

local function initFramework()
    local wanted = string.lower(Config.Framework or 'auto')
    if wanted == 'auto' or wanted == 'qbcore' then
        if GetResourceState('qb-core') == 'started' then
            local ok, core = pcall(function() return exports['qb-core']:GetCoreObject() end)
            if ok and core then QBCore, Framework = core, 'qbcore'; return true end
        end
    end
    if wanted == 'auto' or wanted == 'esx' then
        if GetResourceState('es_extended') == 'started' then
            local ok, core = pcall(function() return exports['es_extended']:getSharedObject() end)
            if ok and core then ESX, Framework = core, 'esx'; return true end
        end
    end
    return false
end

local function safeGet(player, key)
    if not player or type(player.get) ~= 'function' then return nil end
    -- ESX getters are usually closures taking only the key; some forks define methods with self.
    local ok, value = pcall(player.get, key)
    if ok and value ~= nil then return value end
    local methodOk, methodValue = pcall(player.get, player, key)
    if methodOk then return methodValue end
end

local function addressText(value)
    if type(value) == 'table' then
        value = value.label or value.street or value.name or value.address
    end
    if value == nil then return nil end
    value = tostring(value):gsub('^%s*(.-)%s*$', '%1')
    if value == '' then return nil end
    return value
end

local function getCharacter(src)
    if Framework == 'qbcore' then
        local player = QBCore.Functions.GetPlayer(src)
        if not player or not player.PlayerData then return nil end
        local data, char = player.PlayerData, player.PlayerData.charinfo or {}
        local name = table.concat({char.firstname or '', char.lastname or ''}, ' '):gsub('^%s*(.-)%s*$', '%1')
        if name == '' then name = GetPlayerName(src) or 'Ukendt' end
        local gender = char.gender
        if gender == 0 or gender == '0' then gender = 'Mand' elseif gender == 1 or gender == '1' then gender = 'Kvinde' end
        return {
            external_id = 'qbcore:' .. tostring(data.citizenid or GetPlayerIdentifierByType(src, 'license') or src),
            source = 'QBCore', name = name, birth_date = char.birthdate,
            phone = char.phone, address = addressText(char.address or (data.metadata and (data.metadata.address or data.metadata.apartment))), gender = gender
        }
    elseif Framework == 'esx' then
        local player = ESX.GetPlayerFromId(src)
        if not player then return nil end
        local identifier = player.identifier
        if player.getIdentifier then
            local ok, value = pcall(player.getIdentifier, player)
            if ok and value then identifier = value end
        end
        local first = safeGet(player, 'firstName') or player.firstname or ''
        local last = safeGet(player, 'lastName') or player.lastname or ''
        local name = (tostring(first) .. ' ' .. tostring(last)):gsub('^%s*(.-)%s*$', '%1')
        if name == '' and player.getName then
            local ok, value = pcall(player.getName, player)
            if ok then name = value end
        end
        return {
            external_id = 'esx:' .. tostring(identifier or GetPlayerIdentifierByType(src, 'license') or src),
            source = 'ESX', name = name,
            birth_date = safeGet(player, 'dateofbirth') or player.dateofbirth,
            phone = safeGet(player, 'phoneNumber') or safeGet(player, 'phone') or player.phone_number,
            address = addressText(safeGet(player, 'address') or safeGet(player, 'street')),
            gender = safeGet(player, 'sex') or player.sex
        }
    end
end

local function sendCharacter(src, attempt)
    if not GetPlayerName(src) then return end
    local person = getCharacter(src)
    if not person then
        if attempt < (Config.RetryCount or 20) then
            SetTimeout(Config.RetryDelayMs or 1500, function() sendCharacter(src, attempt + 1) end)
        else
            print(('[politi-tablet] Kunne ikke hente karakterdata for spiller %s.'):format(src))
        end
        return
    end
    if not person.external_id or person.name == '' then
        print(('[politi-tablet] Karakteren for spiller %s mangler ID eller navn.'):format(src))
        return
    end
    if not Config.ApiKey or Config.ApiKey == '' then
        print('[politi-tablet] Mangler politi_tablet_api_key server-convar.')
        return
    end
    PerformHttpRequest(Config.ApiUrl .. '/api/integrations/persons', function(status, response)
        if status < 200 or status >= 300 then
            print(('[politi-tablet] Person-sync fejlede for spiller %s (HTTP %s).'):format(src, status))
        end
    end, 'POST', json.encode(person), {
        ['Content-Type'] = 'application/json',
        ['Authorization'] = 'Bearer ' .. Config.ApiKey
    })
end

local function scheduleSync(src)
    src = tonumber(src)
    if not src then return end
    SetTimeout(1200, function() sendCharacter(src, 1) end)
end

AddEventHandler('playerJoining', function()
    scheduleSync(source)
end)

AddEventHandler('QBCore:Server:PlayerLoaded', function(player)
    local src = type(player) == 'table' and player.PlayerData and player.PlayerData.source or source
    scheduleSync(src)
end)
AddEventHandler('QBCore:Server:OnPlayerLoaded', function(src)
    scheduleSync(src or source)
end)
AddEventHandler('esx:playerLoaded', function(src)
    scheduleSync(src or source)
end)

CreateThread(function()
    for _ = 1, 60 do
        if initFramework() then break end
        Wait(1000)
    end
    if not Framework then
        print('[politi-tablet] QBCore/ESX blev ikke fundet. Sæt Config.Framework og start resource efter frameworket.')
        return
    end
    print(('[politi-tablet] Person-sync bruger %s.'):format(Framework))
    for _, player in ipairs(GetPlayers()) do scheduleSync(player) end
end)
