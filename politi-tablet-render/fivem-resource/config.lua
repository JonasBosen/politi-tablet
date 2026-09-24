Config = {}

-- Vælg 'auto', 'qbcore' eller 'esx'.
Config.Framework = 'auto'
Config.ApiUrl = 'https://politi-tablet.onrender.com'
-- Hemmeligheden læses kun på serversiden fra en server.cfg-convar.
Config.ApiKey = GetConvar('politi_tablet_api_key', '')
Config.RetryCount = 20
Config.RetryDelayMs = 1500
