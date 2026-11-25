local depth = 10
local req_str = nil

wrk.method = "POST"
wrk.body   = '{"name":"rxpress","fast":true,"count":42}'
wrk.headers["Content-Type"] = "application/json"

function init(args)
  local r = {}
  for i = 1, depth do
    r[i] = wrk.format()
  end
  req_str = table.concat(r)
end

function request()
  return req_str
end
