class CatworldError(Exception): pass
class AuthenticationError(CatworldError): pass
class PermissionDeniedError(CatworldError): pass
class ValidationError(CatworldError): pass
class QueryTimeoutError(CatworldError): pass
class ConnectionError(CatworldError): pass