import threading
import unittest
from types import SimpleNamespace
from vehicle_commands import VehicleCommands, map_command, proxy_transport, navigation_rest_transport, retry_after_seconds
from vehicle_dashboard import DashboardError


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.now = 100
        self.fresh = {'drive_state': {'shift_state': 'P'}, 'charge_state': {'conn_charge_cable': '<invalid>'}}
        self.dashboard = SimpleNamespace(lock=threading.RLock(), status_until=0, data_until=60, next_data_at=60,
            status=lambda: {'response': {'state': 'online'}}, _target=lambda: 'TEST0000000000001',
            _call=lambda path: {'response': self.fresh}, token_supplier=lambda: 'test-only-oauth')
        def send(path, body, bearer):
            self.calls.append((path, body, bearer))
            return {'response': {'result': True}}
        self.gateway = VehicleCommands(self.dashboard, send, clock=lambda: self.now)
        self.gateway.navigation_transport = send

    def payload(self, command=None, suffix='01'):
        return {'requestId': '00000000-0000-4000-8000-0000000000' + suffix,
                'command': command or {'name': 'horn'}}

    def assert_error(self, status, operation):
        with self.assertRaises(DashboardError) as caught: operation()
        self.assertEqual(caught.exception.status, status)

    def test_disabled_has_no_calls(self):
        gate = VehicleCommands(self.dashboard)
        self.assertFalse(gate.capabilities()['commands'])
        self.assert_error(503, lambda: gate.execute(self.payload()))
        self.assertEqual(self.calls, [])

    def test_whitelist_rejects_injection_and_invalid_values(self):
        bad = [{'name': 'remote_start_drive'}, {'name': 'navigation', 'destination': ''},
               {'name': 'lock', 'locked': 1}, {'name': 'temperature', 'celsius': float('nan')},
               {'name': 'chargeLimit', 'percent': True}, {'name': 'trunk', 'trunk': 'url'},
               {'name': 'horn', 'vin': 'OTHER'}, {'name': 'horn', 'url': 'https://evil.test'}]
        for command in bad:
            with self.subTest(command=command): self.assert_error(400, lambda: map_command(command))
        self.assertEqual(self.calls, [])

    def test_navigation_validates_address_and_maps_official_endpoint(self):
        endpoint, body = map_command({'name': 'navigation', 'destination': ' 示例目的地 '})
        self.assertEqual(endpoint, 'navigation_request')
        self.assertEqual(body['value']['android.intent.extra.TEXT'], '示例目的地')
        self.assertEqual(body['type'], 'share_ext_content_raw')
        self.assertEqual(body['locale'], 'zh-CN')
        self.assertIsInstance(body['timestamp_ms'], int)
        for value in (None, 123, '', ' ', 'x' * 301, 'https://example.com', '北京\n示例区域甲'):
            self.assert_error(400, lambda: map_command({'name': 'navigation', 'destination': value}))

    def test_explicit_lock_and_unlock_do_not_depend_on_stale_lock_state(self):
        for locked, endpoint in ((True, 'door_lock'), (False, 'door_unlock')):
            self.assertEqual(map_command({'name': 'lock', 'locked': locked}), (endpoint, {}))

    def test_paired_commands_have_distinct_explicit_directions(self):
        pairs = [({'name': 'climate', 'enabled': True}, 'auto_conditioning_start'),
                 ({'name': 'climate', 'enabled': False}, 'auto_conditioning_stop'),
                 ({'name': 'charging', 'enabled': True}, 'charge_start'),
                 ({'name': 'charging', 'enabled': False}, 'charge_stop'),
                 ({'name': 'chargePort', 'open': True}, 'charge_port_door_open'),
                 ({'name': 'chargePort', 'open': False}, 'charge_port_door_close')]
        for command, endpoint in pairs: self.assertEqual(map_command(command), (endpoint, {}))
        self.assertEqual(map_command({'name': 'vent'}), ('window_control', {'command': 'vent'}))
        self.assertEqual(map_command({'name': 'closeWindows'}), ('window_control', {'command': 'close'}))
        self.assertEqual(map_command({'name': 'rearTrunk', 'open': False}), ('drivetalk_close_trunk', {}))
        self.assert_error(400, lambda: map_command({'name': 'rearTrunk', 'open': 'close'}))

    def test_close_trunk_requires_capability_and_uses_close_not_toggle(self):
        command = {'name': 'rearTrunk', 'open': False}
        self.assert_error(503, lambda: self.gateway.execute(self.payload(command)))
        self.gateway.rear_close_enabled = True
        self.assertEqual(self.gateway.execute(self.payload(command)), {'accepted': True})
        self.assertEqual(self.calls[0][0], '/api/1/vehicles/TEST0000000000001/command/drivetalk_close_trunk')
        self.assertEqual(len(self.calls), 1)

    def test_open_trunk_never_toggles_open_or_unknown_trunk(self):
        for state in (None, True, -1, float('nan')):
            self.fresh['vehicle_state'] = {'rt': state}
            self.assert_error(409, lambda: self.gateway.execute(self.payload({'name': 'rearTrunk', 'open': True}, suffix=str(int(self.now))[-2:])))
            self.now += 11
        self.fresh['vehicle_state'] = {'rt': 1}
        self.assertEqual(self.gateway.execute(self.payload({'name': 'rearTrunk', 'open': True})), {'accepted': True, 'alreadyInState': True})
        self.assertEqual(self.calls, [])
        self.now += 11
        self.fresh['vehicle_state'] = {'rt': 0}
        self.gateway.execute(self.payload({'name': 'rearTrunk', 'open': True}, suffix='99'))
        self.assertEqual(self.calls[0][1], {'which_trunk': 'rear'})

    def test_stop_charging_and_climate_ignore_stale_off_snapshot(self):
        self.fresh['climate_state'] = {'is_climate_on': False}
        self.fresh['charge_state']['charging_state'] = 'Stopped'
        self.gateway.execute(self.payload({'name': 'climate', 'enabled': False}))
        self.now += 11
        self.gateway.execute(self.payload({'name': 'charging', 'enabled': False}, suffix='02'))
        self.assertEqual([call[0].split('/')[-1] for call in self.calls], ['auto_conditioning_stop', 'charge_stop'])

    def test_start_charging_checks_fresh_cable(self):
        self.assert_error(409, lambda: self.gateway.execute(self.payload({'name': 'charging', 'enabled': True})))
        self.assertEqual(self.calls, [])

    def test_navigation_routes_only_to_owned_vehicle_without_retry(self):
        self.assertEqual(self.gateway.execute(self.payload({'name': 'navigation', 'destination': '示例目的地'})), {'accepted': True})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][0], '/api/1/vehicles/TEST0000000000001/command/navigation_request')
        self.assert_error(409, lambda: self.gateway.execute(self.payload({'name': 'navigation', 'destination': '示例目的地'})))
        self.assertEqual(len(self.calls), 1)

    def test_navigation_rejects_non_tesla_urls(self):
        for base in ('http://fleet-api.prd.cn.vn.cloud.tesla.cn', 'https://evil.invalid', 'https://fleet-api.prd.cn.vn.cloud.tesla.cn/evil', 'https://u:p@fleet-api.prd.cn.vn.cloud.tesla.cn'):
            with self.assertRaises(ValueError): navigation_rest_transport(base)

    def test_owned_target_and_server_oauth_used_once(self):
        self.assertEqual(self.gateway.execute(self.payload({'name': 'temperature', 'celsius': 22.5})), {'accepted': True})
        self.assertEqual(self.calls, [('/api/1/vehicles/TEST0000000000001/command/set_temps', {'driver_temp': 22.5, 'passenger_temp': 22.5}, 'test-only-oauth')])

    def test_duplicate_and_cooldown_do_not_send(self):
        self.gateway.execute(self.payload())
        self.assert_error(409, lambda: self.gateway.execute(self.payload()))
        self.assert_error(429, lambda: self.gateway.execute(self.payload(suffix='02')))
        self.assertEqual(len(self.calls), 1)

    def test_sleep_blocks_all_and_unknown_gear_blocks_park_only_commands_without_wake(self):
        self.dashboard.status = lambda: {'response': {'state': 'asleep'}}
        self.assert_error(409, lambda: self.gateway.execute(self.payload()))
        self.now += 11
        self.dashboard.status = lambda: {'response': {'state': 'online'}}
        self.fresh['drive_state']['shift_state'] = None
        self.assert_error(409, lambda: self.gateway.execute(self.payload({'name': 'chargePort', 'open': True}, suffix='02')))
        self.assertEqual(self.calls, [])

    def test_only_trunks_and_charge_port_require_explicit_park(self):
        commands = [{'name':'trunk','trunk':'front'}, {'name':'trunk','trunk':'rear'},
                    {'name':'rearTrunk','open':True}, {'name':'rearTrunk','open':False},
                    {'name':'chargePort','open':True}, {'name':'chargePort','open':False}]
        self.gateway.rear_close_enabled = True
        self.fresh['vehicle_state'] = {'rt':0}
        index = 0
        for gear in ('P','R','N','D',None,'unknown'):
            for command in commands:
                with self.subTest(gear=gear,command=command):
                    self.fresh['drive_state'] = {'shift_state':gear}
                    before = len(self.calls)
                    payload = self.payload(command, suffix=f'{index:02d}')
                    if gear == 'P':
                        self.assertTrue(self.gateway.execute(payload)['accepted'])
                        self.assertEqual(len(self.calls),before+1)
                    else:
                        self.assert_error(409,lambda:self.gateway.execute(payload))
                        self.assertEqual(len(self.calls),before)
                    self.now += 11; index += 1

    def test_other_supported_commands_do_not_depend_on_gear(self):
        commands = [{'name':'lock','locked':True}, {'name':'lock','locked':False},
                    {'name':'climate','enabled':True}, {'name':'climate','enabled':False},
                    {'name':'temperature','celsius':22}, {'name':'chargeLimit','percent':80},
                    {'name':'charging','enabled':False}, {'name':'charging','enabled':True},
                    {'name':'navigation','destination':'测试地点'}, {'name':'vent'}, {'name':'closeWindows'},
                    {'name':'horn'}, {'name':'lights'}, {'name':'findCar'}]
        self.fresh['charge_state']['conn_charge_cable'] = 'IEC'
        index = 0
        for gear in ('P','R','N','D',None):
            for command in commands:
                with self.subTest(gear=gear,command=command):
                    self.fresh['drive_state'] = {'shift_state':gear}
                    self.assertTrue(self.gateway.execute(self.payload(command,suffix=f'{index:02d}'))['accepted'])
                    self.now += 11; index += 1

    def test_missing_gear_does_not_mean_park_and_invalid_snapshot_still_fails(self):
        self.fresh.pop('drive_state')
        self.assert_error(409, lambda:self.gateway.execute(self.payload({'name':'trunk','trunk':'front'})))
        self.now += 11
        self.assertTrue(self.gateway.execute(self.payload({'name':'climate','enabled':False},suffix='02'))['accepted'])
        self.now += 11
        self.dashboard._call = lambda path: {'response':None}
        self.assert_error(409, lambda:self.gateway.execute(self.payload(suffix='03')))

    def test_close_port_unknown_or_connected_cable_is_rejected(self):
        self.fresh['charge_state'] = {}
        self.assert_error(409, lambda: self.gateway.execute(self.payload({'name': 'chargePort', 'open': False})))
        self.assertEqual(self.calls, [])

    def test_ambiguous_proxy_does_not_retry_and_invalidates_snapshot(self):
        count = []
        def fail(*args): count.append(1); raise TimeoutError()
        self.gateway.transport = fail
        with self.assertRaises(TimeoutError): self.gateway.execute(self.payload())
        self.assertEqual(len(count), 1)
        self.assertEqual(self.dashboard.data_until, 0)
        self.assert_error(409, lambda: self.gateway.execute(self.payload()))

    def test_false_result_is_not_success(self):
        self.gateway.transport = lambda *args: {'response': {'result': False}}
        self.assert_error(502, lambda: self.gateway.execute(self.payload()))

    def test_find_car_second_failure_is_partial_and_never_retried(self):
        count = []
        def partial(*args):
            count.append(1)
            if len(count) == 2: raise TimeoutError()
            return {'response': {'result': True}}
        self.gateway.transport = partial
        self.assert_error(502, lambda: self.gateway.execute(self.payload({'name': 'findCar'})))
        self.assertEqual(len(count), 2)

    def test_proxy_rejects_http_external_host_paths_and_missing_ca(self):
        for url in ['http://localhost:4443', 'https://evil.test', 'https://localhost:4443/redirect', 'https://u:p@localhost:4443', 'https://localhost:4443?token=x', 'https://localhost:4443']:
            with self.subTest(url=url):
                with self.assertRaises(ValueError): proxy_transport(url, '')

    def test_busy_rejects_without_send(self):
        self.gateway.lock.acquire()
        try: self.assert_error(409, lambda: self.gateway.execute(self.payload()))
        finally: self.gateway.lock.release()
        self.assertEqual(self.calls, [])

    def test_upstream_429_backoff_blocks_commands_on_the_server(self):
        attempts = []
        def limited(*args):
            attempts.append(1)
            raise DashboardError(429, 'upstream limit', 180)
        self.gateway.transport = limited
        self.assert_error(429, lambda: self.gateway.execute(self.payload()))
        self.now += 11
        with self.assertRaises(DashboardError) as error:
            self.gateway.execute(self.payload(suffix='02'))
        self.assertGreater(error.exception.retry_after, 160)
        self.assertEqual(len(attempts), 1)

    def test_retry_after_preserves_long_upstream_wait(self):
        self.assertEqual(retry_after_seconds({'Retry-After': '3600'}), 3600)
        self.assertEqual(retry_after_seconds({'Retry-After': 'invalid'}), 60)


if __name__ == '__main__': unittest.main()
