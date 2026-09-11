"""4 provider LLM doc lap, cung 1 interface: send(api_key, model, system, messages, **cfg) -> str.

`messages` la list [{"role": "user"|"assistant", "content": str}, ...] (khong co
"system" trong messages - system truyen rieng). Loi mang/HTTP/SDK duoc nem nguyen
(khong nuot) de tang o server bien thanh error_response thong nhat.
"""
