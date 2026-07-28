export const MINION_ACP_SITECUSTOMIZE = String.raw`
"""Agent Tower session-scoped MCP bridge for minion-code ACP."""

import asyncio
import json
import tempfile
from pathlib import Path

if not globals().get("_AGENT_TOWER_MINION_MCP_PATCHED"):
    _AGENT_TOWER_MINION_MCP_PATCHED = True
    from minion_code.acp_server import agent as _agent_module
    from minion_code.utils.mcp_loader import MCPToolsLoader

    _original_create_agent = _agent_module.ACPSession._create_agent
    _original_set_mode = _agent_module.ACPSession.set_mode
    _create_lock = asyncio.Lock()

    def _value(item, name, default=None):
        if isinstance(item, dict):
            return item.get(name, default)
        return getattr(item, name, default)

    def _pairs(value):
        if isinstance(value, dict):
            return {str(key): str(item) for key, item in value.items()}
        result = {}
        for item in value or []:
            name = _value(item, "name")
            content = _value(item, "value")
            if name is not None and content is not None:
                result[str(name)] = str(content)
        return result

    def _server_config(server):
        name = _value(server, "name")
        if not name:
            raise ValueError("ACP MCP server name is required.")
        command = _value(server, "command")
        if command:
            return {
                "command": str(command),
                "args": [str(arg) for arg in (_value(server, "args", []) or [])],
                "env": _pairs(_value(server, "env", [])),
            }
        url = _value(server, "url")
        if url:
            server_type = type(server).__name__.lower()
            return {
                "type": "sse" if "sse" in server_type else "http",
                "url": str(url),
                "headers": _pairs(_value(server, "headers", [])),
            }
        raise ValueError(f"Unsupported ACP MCP server: {name}")

    async def _load_session_tools(session):
        servers = list(getattr(session, "mcp_servers", []) or [])
        if not servers:
            return [], None
        directory = Path(tempfile.mkdtemp(prefix="agent-tower-minion-mcp-"))
        config_path = directory / "mcp.json"
        config = {"mcpServers": {str(_value(server, "name")): _server_config(server) for server in servers}}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        loader = MCPToolsLoader(config_path=config_path, auto_discover=False, project_dir=Path(session.cwd))
        loader.load_config()
        try:
            tools = await loader.load_all_tools()
        except Exception:
            await loader.close()
            raise
        finally:
            config_path.unlink(missing_ok=True)
            directory.rmdir()
        return tools, loader

    async def _patched_create_agent(session):
        tools, loader = await _load_session_tools(session)
        session._agent_tower_mcp_loader = loader
        if not tools:
            try:
                return await _original_create_agent(session)
            except Exception:
                if loader is not None:
                    await loader.close()
                session._agent_tower_mcp_loader = None
                raise

        from minion_code.agents.code_agent import MinionCodeAgent
        original_descriptor = MinionCodeAgent.__dict__["create"]
        original_bound = MinionCodeAgent.create

        async def create_with_mcp(cls, *args, **kwargs):
            existing = list(kwargs.get("additional_tools") or [])
            kwargs["additional_tools"] = existing + tools
            return await original_bound(*args, **kwargs)

        async with _create_lock:
            MinionCodeAgent.create = classmethod(create_with_mcp)
            try:
                return await _original_create_agent(session)
            except Exception:
                await loader.close()
                session._agent_tower_mcp_loader = None
                raise
            finally:
                MinionCodeAgent.create = original_descriptor

    async def _patched_set_mode(session, mode_id):
        previous_loader = getattr(session, "_agent_tower_mcp_loader", None)
        try:
            return await _original_set_mode(session, mode_id)
        finally:
            if previous_loader is not None and previous_loader is not getattr(session, "_agent_tower_mcp_loader", None):
                await previous_loader.close()

    _agent_module.ACPSession._create_agent = _patched_create_agent
    _agent_module.ACPSession.set_mode = _patched_set_mode
`;
